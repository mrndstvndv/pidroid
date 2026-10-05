/**
 * Provider authentication for the embedded agent: a file-backed credential
 * store plus a login manager that bridges pi-ai's login flows
 * (`prompt()`/`notify()`) to the webview over HTTP + WebSocket.
 */

import type {
  AuthEvent,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
  MutableModels,
} from "@earendil-works/pi-ai";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Providers that never show a login (the OpenCode free tier is anonymous). */
export const HIDDEN_PROVIDERS = new Set(["opencode"]);

/* ------------------------------------------------------------------ *
 * Credential store (auth.json, mode 600)
 * ------------------------------------------------------------------ */

export class FileCredentialStore implements CredentialStore {
  private data: Record<string, Credential> = {};
  /** Serializes writes so concurrent refreshes cannot clobber each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as Record<string, Credential>;
      } catch (err) {
        console.warn(`[pidroid] Ignoring unreadable ${path}:`, err);
      }
    }
  }

  private persist() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {}
  }

  private serialize<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  async read(providerId: string) {
    return this.data[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.serialize(async () => {
      const next = await fn(this.data[providerId]);
      if (next) {
        this.data[providerId] = next;
        this.persist();
      }
      return this.data[providerId];
    });
  }

  delete(providerId: string) {
    return this.serialize(() => {
      if (providerId in this.data) {
        delete this.data[providerId];
        this.persist();
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * Login manager
 * ------------------------------------------------------------------ */

type Broadcast = (event: string, payload: unknown) => void;

interface PendingPrompt {
  id: string;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
}

interface LoginSession {
  id: string;
  providerId: string;
  abort: AbortController;
  prompts: Map<string, PendingPrompt>;
}

export interface ProviderStatus {
  id: string;
  name: string;
  oauth: boolean;
  /** True when the provider's api-key flow can be started (has its own login, or accepts a pasted key). */
  apiKey: boolean;
  /** Provider ships its own interactive api-key login (e.g. extra fields besides the key). */
  apiKeyLogin: boolean;
  configured: boolean;
  /** "oauth" | "api_key" when configured. */
  type?: string;
  /** Where the credential comes from: "stored credential", an env var name, ... */
  source?: string;
  modelCount: number;
}

export class LoginManager {
  private sessions = new Map<string, LoginSession>();

  constructor(
    private readonly models: MutableModels,
    private readonly store: FileCredentialStore,
    private readonly broadcast: Broadcast,
  ) {}

  async providers(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = [];
    for (const provider of this.models.getProviders()) {
      if (HIDDEN_PROVIDERS.has(provider.id)) continue;
      const auth = provider.auth;
      if (!auth.oauth && !auth.apiKey) continue;
      let check: Awaited<ReturnType<MutableModels["checkAuth"]>>;
      try {
        check = await this.models.checkAuth(provider.id);
      } catch {
        check = undefined;
      }
      const stored = await this.store.read(provider.id);
      out.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        oauth: !!auth.oauth,
        apiKey: !!auth.apiKey,
        apiKeyLogin: !!auth.apiKey?.login,
        configured: !!check,
        type: check?.type ?? stored?.type,
        source: stored ? "stored credential" : check?.source,
        modelCount: this.models.getModels(provider.id).length,
      });
    }
    // Configured first, then alphabetical.
    return out.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  }

  /** Store a pasted API key for providers that have no login flow of their own. */
  async saveApiKey(providerId: string, key: string) {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("API key is empty");
    if (!this.models.getProvider(providerId)?.auth.apiKey) throw new Error(`${providerId} does not use API keys`);
    await this.store.modify(providerId, async () => ({ type: "api_key", key: trimmed }) as Credential);
  }

  async logout(providerId: string) {
    await this.models.logout(providerId);
    await this.store.delete(providerId);
  }

  /** Start a provider-driven login (OAuth, or an api-key flow with its own prompts). Returns the login id. */
  start(providerId: string, type: "oauth" | "api_key"): string {
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const id = `login_${crypto.randomUUID()}`;
    const session: LoginSession = { id, providerId, abort: new AbortController(), prompts: new Map() };
    this.sessions.set(id, session);

    const emit = (payload: Record<string, unknown>) => this.broadcast("login", { loginId: id, providerId, ...payload });

    void (async () => {
      try {
        await this.models.login(providerId, type, {
          signal: session.abort.signal,
          notify: (event: AuthEvent) => emit({ kind: "notify", event }),
          prompt: (prompt: AuthPrompt) =>
            new Promise<string>((resolve, reject) => {
              const promptId = crypto.randomUUID();
              session.prompts.set(promptId, { id: promptId, resolve, reject });
              // A prompt can be withdrawn by the flow itself (e.g. the callback server won the race).
              prompt.signal?.addEventListener("abort", () => {
                session.prompts.delete(promptId);
                reject(new Error("prompt cancelled"));
                emit({ kind: "prompt_cancelled", promptId });
              });
              const { signal: _signal, ...serializable } = prompt;
              emit({ kind: "prompt", promptId, prompt: serializable });
            }),
        });
        emit({ kind: "done" });
      } catch (err) {
        emit({ kind: session.abort.signal.aborted ? "cancelled" : "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        for (const pending of session.prompts.values()) pending.reject(new Error("login ended"));
        this.sessions.delete(id);
      }
    })();

    return id;
  }

  answer(loginId: string, promptId: string, value: string) {
    const pending = this.sessions.get(loginId)?.prompts.get(promptId);
    if (!pending) throw new Error("No such pending prompt");
    this.sessions.get(loginId)!.prompts.delete(promptId);
    pending.resolve(value);
  }

  cancel(loginId: string) {
    this.sessions.get(loginId)?.abort.abort();
  }
}
