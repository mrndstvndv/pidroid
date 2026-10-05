import { Database } from "bun:sqlite";
import { join, dirname, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, hook, section, ToolTask, type Conversation } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import WebTools from "./web-tools.ts";
import { commandCodeProvider, commandCodeUsage, commandCodeUsageData } from "./providers/commandcode.ts";
import { opencodeProvider } from "./providers/opencode.ts";
import { FileCredentialStore, LoginManager } from "./auth.ts";
import { Changes } from "./changes.ts";
import { ExtensionLoader } from "./extensions.ts";
import { DEFAULT_TITLE, Sessions, type SessionRow } from "./sessions.ts";
import { buildChatView, clampLevel, supportedLevels, type ChatView } from "./chatview.ts";

const PORT = Number(process.env.PORT) || 8765;
/** The app itself: the server, the UI and the git checkpoint journal. */
const APP_DIR = process.cwd();
const WWW_DIR = join(APP_DIR, "www");
const DB_PATH = join(APP_DIR, "pidroid.sqlite");

/**
 * One directory per session, so sessions stop fighting over the same files. It is a sibling of the
 * app directory on purpose: changes.ts checkpoints the whole app tree after every turn, and session
 * scratch work has no business in that journal (or in the Changes tab, or in a saved bundle). The
 * cost is that the harness code is no longer the working directory, so the agent reaches it by
 * absolute path ($PIDROID_APP_DIR).
 */
const WORKSPACES_DIR = join(dirname(APP_DIR), "workspaces");
const UPLOADS_DIR = join(APP_DIR, "uploads");
const workspaceDir = (conversationId: number) => join(WORKSPACES_DIR, String(conversationId));

/* ---------- file tree (Files tab) ----------
   The Files tab mirrors what the save_bundle extension archives, so its skip lists duplicate the
   SKIP_DIRS / SKIP_FILES / SKIP_SUFFIXES constants in extensions/save-bundle.ts. If one changes, the
   other must too -- otherwise the tab would promise files a bundle silently drops. */
const TREE_SKIP_DIRS = new Set([".git", "node_modules", "vendor", "fallback", ".bun", ".tmp", ".bundle-staging"]);
const TREE_SKIP_FILES = new Set(["auth.json", "auth.json.tmp", ".installed_version", ".shipped_manifest.json"]);
const TREE_SKIP_SUFFIXES = [".sqlite", ".sqlite-shm", ".sqlite-wal"];

/** Largest file the tree preview will render. Above this the tab shows the size and nothing else. */
const MAX_READ_BYTES = 512 * 1024;

function sha256Hex(buf: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

// Initialize SQLite database
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agent_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

console.log(`[pidroid] Agent runtime initialized. SQLite DB at: ${DB_PATH}`);

// Active WebSocket clients (for live agent events and UI hot-reloading)
const clients = new Set<any>();

function broadcast(event: string, payload: any) {
  const message = JSON.stringify({ event, payload, timestamp: Date.now() });
  for (const ws of clients) {
    try {
      ws.send(message);
    } catch {
      clients.delete(ws);
    }
  }
}

// Every agent turn is bracketed by git checkpoints so changes can be inspected and undone.
const changes = new Changes(process.cwd());
await changes.init();

// --- pi-durable agent ---------------------------------------------------
const context = BACKGROUND_CONTEXT;
const AGENT_DB_PATH = join(process.cwd(), "pidroid-agent.sqlite");

/**
 * pi-ai's default models store is in-memory, so a refreshed catalog dies with
 * the process and every boot falls back to the provider's bundled snapshot.
 * That is how Command Code kept losing models the API had already published
 * (the snapshot is a snapshot: DeepSeek V4.1 Flash was missing from it).
 * Persisting the published catalogs makes a refresh stick across restarts.
 */
const MODELS_STORE_PATH = join(process.cwd(), "pidroid-models.json");

class FileModelsStore {
  private entries = new Map<string, unknown>();

  constructor(private path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof raw === "object" && raw !== null) {
        for (const [providerId, entry] of Object.entries(raw)) this.entries.set(providerId, entry);
      }
    } catch {
      // Missing or corrupt: start empty and let the next refresh rewrite it.
    }
  }

  async read(providerId: string, options?: { signal?: AbortSignal }): Promise<any> {
    options?.signal?.throwIfAborted();
    const entry = this.entries.get(providerId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async write(providerId: string, entry: unknown, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    this.entries.set(providerId, structuredClone(entry));
    this.flush();
  }

  async delete(providerId: string, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    this.entries.delete(providerId);
    this.flush();
  }

  /** Write-then-rename so a kill mid-write cannot leave a truncated catalog. */
  private flush() {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
      renameSync(tmp, this.path);
    } catch {}
  }
}

// Every pi-ai built-in provider, plus the ported OpenCode Zen free tier and
// Command Code providers (same ids replace the built-in versions).
const credentials = new FileCredentialStore(join(process.cwd(), "auth.json"));
const models = builtinModels({ credentials, modelsStore: new FileModelsStore(MODELS_STORE_PATH) });
models.setProvider(opencodeProvider());
models.setProvider(commandCodeProvider());

// Catalogs self-heal at boot; without this the picker only ever shows whatever
// the last manual "Refresh catalogs" produced (and nothing, on a fresh install).
void models
  .refresh({ providers: ["opencode", "commandcode"], signal: AbortSignal.timeout(30_000) })
  .then(() => broadcast("providers_changed", {}))
  .catch(() => {});

const logins = new LoginManager(models, credentials, broadcast);

/**
 * Providers that can report account usage for the UI, keyed by provider id. Each entry gets
 * the API key from the provider's own auth resolution, so a stored credential, an env var,
 * and the CLI's own auth file all behave the same way.
 */
const usageSources: Record<string, (apiKey: string, signal: AbortSignal) => Promise<unknown>> = {
  commandcode: commandCodeUsageData,
};

/** The key a provider would send, resolved through its own api-key auth flow. */
async function providerApiKey(providerId: string): Promise<string | undefined> {
  const apiKeyAuth = models.getProvider(providerId)?.auth?.apiKey;
  if (!apiKeyAuth) return undefined;
  const credential = await credentials.read(providerId).catch(() => undefined);
  const resolved = await apiKeyAuth
    .resolve({ credential } as Parameters<typeof apiKeyAuth.resolve>[0])
    .catch(() => undefined);
  return resolved?.auth?.apiKey;
}

/**
 * Android kills an app that spawns too many child processes (the "phantom process" limit), which takes the whole agent
 * down. Probing loops over /proc, whole-device finds and greps of the generated bundle are the usual culprits, and
 * none of them help with the task, so they are refused with a pointer to the right place.
 */
function blockedBashReason(command: string): string | undefined {
  if (/\/proc\/(\[|\*|\$|\{)/.test(command)) return "Looping over /proc spawns hundreds of processes and gets this app killed by Android. Don't enumerate processes.";
  if (/\bfind\s+\/(\s|$|data\s|proc|sys|system|vendor|apex)/.test(command)) return "Whole-device find is refused (slow, and it can get this app killed). Search inside the workspace only.";
  if (/\b(server\.js|vendor\/|fallback\/)/.test(command)) return `${APP_DIR}/vendor and ${APP_DIR}/fallback are generated minified bundles; reading them is useless. Read server.ts, auth.ts, changes.ts, chatview.ts, sessions.ts, extensions.ts and providers/ in ${APP_DIR} instead.`;
  return undefined;
}

/** Exit code the Android app treats as "restart me now" (anything else counts as a crash). */
const PLANNED_EXIT_CODE = 75;

/** Exit so the app relaunches this server; the flag tells the next boot that unfinished runs should resume, not abort. */
function scheduleRestart(delayMs: number) {
  setState("planned_restart", String(Date.now()));
  console.log(`[pidroid] planned restart in ${delayMs}ms`);
  setTimeout(() => process.exit(PLANNED_EXIT_CODE), delayMs);
}

/** Bundle server.ts into a temp file: catches syntax errors and unresolved imports before they take the server down. */
async function preflight(): Promise<string | undefined> {
  const out = join(tmpdir(), `pidroid-preflight-${Date.now()}.js`);
  try {
    const proc = Bun.spawn([process.execPath, "build", "server.ts", "--target=bun", `--outfile=${out}`], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return code === 0 ? undefined : `${stderr}${stdout}`.trim().slice(0, 3000) || `bun build exited with code ${code}`;
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * Reloading the page mid-run throws away what the user is looking at (streaming text, open sections), so changes to
 * HTML/JS don't reload it on their own while the agent works. CSS swaps in place and is applied at once. The agent
 * calls reload_ui when a batch of edits is done; if it forgets, the page reloads once everything is idle.
 */
let pendingReload = false;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

function requestUiReload(filename: string | null | undefined) {
  if (filename?.endsWith(".css")) {
    broadcast("ui_reload", { filename });
    return;
  }
  pendingReload = true;
  checkIdleThenReload(600);
}

function checkIdleThenReload(delayMs: number) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    reloadTimer = undefined;
    if (!pendingReload) return;
    const busy = await busySessions().catch(() => new Set<number>());
    if (busy.size > 0) {
      checkIdleThenReload(2000); // still working: look again shortly
    } else {
      pendingReload = false;
      broadcast("ui_reload", { filename: "index.html" });
    }
  }, delayMs);
}

const reloadUiTool = defineTool({
  name: "reload_ui",
  description:
    "Reload the web UI on the user's screen so your edits to www/ (HTML or JS) take effect. Editing those files does NOT reload the page by itself while you are working, " +
    "so the user's screen stays stable; call this once, after you have finished a batch of UI edits. CSS-only changes apply immediately without it.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    pendingReload = false;
    if (reloadTimer) clearTimeout(reloadTimer);
    setTimeout(() => broadcast("ui_reload", { filename: "index.html" }), 800); // let this tool result commit first
    api.output("The UI will reload in a moment.");
    return {};
  },
});

const reloadExtensionsTool = defineTool({
  name: "reload_extensions",
  description:
    "Re-import every file in extensions/ and hot-swap the extensions (tools, prompt sections, hooks) without restarting. " +
    "Running work finishes on the old code; the next tool call or request uses the new one. Reports import errors per file.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    const result = await loader.reload();
    const lines = [
      ...result.loaded.map((l) => `loaded ${l}`),
      ...result.removed.map((r) => `removed ${r}`),
      ...Object.entries(result.errors).map(([file, error]) => `ERROR ${file}: ${error}`),
    ];
    api.output(lines.join("\n") || "no extension files");
    return {};
  },
});

const restartServerTool = defineTool({
  name: "restart_server",
  description:
    "Restart the agent server so edits to server.ts, auth.ts, changes.ts, chatview.ts, sessions.ts, extensions.ts, web-tools.ts or providers/ take effect. " +
    "It first checks that server.ts still builds and refuses to restart if not. Every session continues afterwards; unfinished runs resume. " +
    "If the new server fails to start 3 times the app falls back to a known-good safe-mode server so the user can undo the edit. " +
    "For tools, prompt sections and hooks prefer reload_extensions, which needs no restart.",
  parameters: Type.Object({ reason: Type.Optional(Type.String({ description: "Why the restart is needed" })) }),
  execute: async (_args, api) => {
    const problem = await preflight();
    if (problem) throw new Error(`Not restarting: server.ts does not build.\n${problem}`);
    // scheduleRestart arms a timer that exits this process, so this run stops right here and the app's
    // next launch picks it up again (harness.resume). Nothing after this tool call runs in this process,
    // which is why the message says so instead of the reassuring "your session continues".
    api.output(
      "Preflight passed, so the restart is committed and cannot be called off. " +
        "This process exits in about a second; the app relaunches the server, which resumes this run from here. " +
        "Your file edits are already on disk, so nothing has to be redone. " +
        "Make this the last tool call of the turn: any command run after it dies with the old process. " +
        "Finish anything left by writing files, not by running them.",
    );
    scheduleRestart(1500);
    return {};
  },
});

const SelfModify = defineExtension({
  name: "pidroid",
  tools: [reloadUiTool, reloadExtensionsTool, restartServerTool],
  sections: [
    section(
      "pidroid",
      () =>
        "You are the agent embedded in the Pidroid Android app, running on Bun inside the app's own process sandbox. " +
        `Your working directory is this session's own workspace (${WORKSPACES_DIR}/<session id>, also $PIDROID_WORKSPACE): scratch files, scripts and experiments belong there and are yours alone. ` +
        `It is NOT version controlled: nothing in it is checkpointed, so nothing in it can be undone -- if the user wants to keep something, copy it into the app tree (below). ` +
        `The app itself lives at ${APP_DIR} (also $PIDROID_APP_DIR), and you can change it -- every path below is relative to it: ` +
        "www/ is the web UI (index.html, style.css, app.js, chat.js, sessions.js, providers.js, changes.js); CSS edits apply instantly, but HTML/JS edits only show after you call reload_ui (call it once when a batch of UI edits is finished, not after every file). " +
        "extensions/*.ts are hot-swappable pi-durable extensions (extensions/save-bundle.ts is a worked example): add tools, prompt sections and hooks there, then call reload_extensions. No restart is needed. " +
        "server.ts, auth.ts, changes.ts, chatview.ts, sessions.ts, extensions.ts, web-tools.ts and providers/ are the server; after editing them call restart_server (it builds first and refuses if the build fails; all sessions continue afterwards). " +
        "vendor/ holds prebuilt dependencies and is not editable; only the packages mapped in tsconfig.json can be imported. " +
        `Files the user attaches from the phone are saved under ${UPLOADS_DIR} (also $PIDROID_UPLOADS); the path you are given for one is absolute, so use it as is. ` +
        "The UI is black (AMOLED) themed; keep it that way. " +
        "Every turn is checkpointed to git, so the user can undo your changes to the app (the workspace is not). If the server fails to start repeatedly the app falls back to a safe-mode server, so a broken edit can be undone from the Changes tab. " +
        "The Android shell around the web view (Kotlin) is not part of your sandbox and cannot be edited from here; if a feature needs it, say so instead of searching the device. " +
        "The shell userland on this phone is Android's toybox/mksh, not GNU: expect missing or different flags (cat -A is unsupported; use cat -etv, od -c, or read the file with the read tool; prefer small portable commands). " +
        "On PATH: bun (the full CLI: bun run / test / build / install / add), bunx, ssh and ssh-keygen. Use bun to try out your own changes: run scripts and `bun test` against extensions in isolation, and `bun build server.ts --target=bun --outfile=/tmp/x.js` to check that the server still builds. " +
        "Never `bun run server.ts` (a second server would fight this one for the port and the databases). " +
        "A package's own CLI cannot be started through bunx or node_modules/.bin on Android (those scripts start with #!/usr/bin/env, which does not exist here): after `bun add <pkg>` run its script directly, e.g. `bun node_modules/<pkg>/bin/<cli>.js`. " +
        "Keep shell commands small and targeted; never loop over /proc or search the whole filesystem.",
      { tag: false },
    ),
  ],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => {
        if (call.name !== "bash") return undefined;
        const command = String((call.arguments as { command?: unknown })?.command ?? "");
        const reason = blockedBashReason(command);
        return reason ? { block: reason } : undefined;
      },
    }),
  ],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(SelfModify);
registry.install(WebTools);
const loader = new ExtensionLoader(registry, join(APP_DIR, "extensions"), file => !disabledExtensions().has(file));
{
  const loaded = await loader.reload();
  for (const line of loaded.loaded) console.log(`[pidroid] extension ${line}`);
  for (const [file, error] of Object.entries(loaded.errors)) console.warn(`[pidroid] extension ${file} failed: ${error}`);
}

const harness = await Harness.open(
  await openNodeSqliteStorage(AGENT_DB_PATH),
  {
    models,
    registry,
    env: ({ conversationId, cwd }) => {
      // Each conversation runs in its own workspace; a conversation without a stored cwd (a session
      // created before workspaces existed, and only for the turn or two before the migration runs)
      // still gets a directory of its own rather than sharing the app tree.
      const dir = cwd ? join(cwd) : workspaceDir(Number(conversationId));
      mkdirSync(dir, { recursive: true });
      // Hand the shell a valid $PWD. Without it bash falls back to its own getcwd(), which walks up through parent
      // directories; the app sandbox can't list /data/user/0 or /data, so every command printed
      // "shell-init: error retrieving current directory: getcwd: cannot access parent directories".
      return new NodeExecutionEnv({
        cwd: dir,
        shellEnv: { PWD: dir, PIDROID_WORKSPACE: dir, PIDROID_APP_DIR: APP_DIR, PIDROID_UPLOADS: UPLOADS_DIR },
      });
    },
    // A hung provider request must fail (and retry) instead of blocking the queue forever.
    settings: { stream: { timeoutMs: 180_000 }, retry: { maxRetries: 2 } },
  },
  context,
);

function getState(key: string): string | undefined {
  return (db.query("SELECT value FROM agent_state WHERE key = ?").get(key) as { value: string } | null)?.value;
}
function setState(key: string, value: string) {
  db.query("INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// Which extension files the user has switched off in Settings. Read fresh on every reload rather than
// captured once, so a toggle applies to the next hot-swap without a restart.
const DISABLED_EXTENSIONS_KEY = "extensions.disabled";
function disabledExtensions(): Set<string> {
  try {
    const parsed = JSON.parse(getState(DISABLED_EXTENSIONS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : []);
  } catch {
    return new Set();
  }
}
function setExtensionEnabled(file: string, enabled: boolean) {
  const disabled = disabledExtensions();
  if (enabled) disabled.delete(file);
  else disabled.add(file);
  setState(DISABLED_EXTENSIONS_KEY, JSON.stringify([...disabled]));
}

// --- Sessions: any number of pi-durable conversations, one shown at a time ---------------------------------
const sessions = new Sessions(db);
const handles = new Map<number, Conversation>();
let current!: SessionRow;
let root!: Conversation; // the displayed session's conversation; handlers capture it at request start

/**
 * The model new sessions start with. An explicit choice (the chooser's star, or the "model"
 * state) wins; otherwise this fallback. It is deliberately not "whatever provider happens to
 * have a key": a default that changes because you signed in somewhere else is not a default.
 */
const FALLBACK_MODEL = { provider: "opencode", modelId: "space-bunny-free" } as const;

function defaultModel(): { provider: string; modelId: string } {
  const saved = getState("model");
  if (saved) {
    const [provider, ...rest] = saved.split("/");
    const modelId = rest.join("/");
    if (models.getModel(provider, modelId)) return { provider, modelId };
  }
  return { ...FALLBACK_MODEL };
}

/** The displayed session's model, falling back to the default. */
function pickDefaultModel(): { provider: string; modelId: string } {
  if (current?.model) {
    const [provider, ...rest] = current.model.split("/");
    const modelId = rest.join("/");
    if (models.getModel(provider, modelId)) return { provider, modelId };
  }
  return defaultModel();
}

/** Preferred thinking effort for the displayed session, clamped to what its model supports. */
function thinkingInfo() {
  const agent = pickDefaultModel();
  const levels = supportedLevels(models.getModel(agent.provider, agent.modelId));
  const preferred = current?.thinking ?? getState("thinking") ?? "medium";
  return { current: clampLevel(preferred, levels), preferred, levels };
}

async function applyThinking() {
  await root.configure({ thinkingLevel: thinkingInfo().current as any }, context);
}

async function handleFor(row: SessionRow): Promise<Conversation> {
  let conv = handles.get(row.conversationId);
  if (!conv) {
    conv = await harness.conversation(row.conversationId as any, context);
    if (!conv) throw new Error(`Conversation ${row.conversationId} is missing from storage`);
    handles.set(row.conversationId, conv);
  }
  return conv;
}

async function createSession(): Promise<SessionRow> {
  const model = pickDefaultModel();
  const thinking = thinkingInfo().current;
  const conv = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model, thinkingLevel: thinking as any } },
    context,
  );
  const row = sessions.create(Number(conv.id), DEFAULT_TITLE, `${model.provider}/${model.modelId}`, thinking);
  handles.set(row.conversationId, conv);
  await pointAtWorkspace(row);
  return row;
}

/** Give a session its own working directory (created on demand) and make the agent run there. */
async function pointAtWorkspace(row: SessionRow): Promise<string> {
  const dir = workspaceDir(row.conversationId);
  mkdirSync(dir, { recursive: true });
  const conv = await handleFor(row);
  await conv.configure({ cwd: dir } as any, context);
  return dir;
}

// The conversation that existed before sessions were introduced becomes the first session.
if (sessions.list().length === 0) {
  const legacy = await harness.root(context, { agent: { model: defaultModel() } });
  sessions.create(Number(legacy.id), "Session 1");
  handles.set(Number(legacy.id), legacy);
}
{
  const saved = Number(getState("session"));
  current = sessions.get(saved) ?? sessions.list()[0];
  root = await handleFor(current);
}
await applyThinking();

// Sessions created before per-session workspaces existed have no cwd stored and would still run in
// the app tree. Point each one at its own directory once; the marker keeps later boots from rewriting
// the doc on every start.
if (getState("workspaces") !== WORKSPACES_DIR) {
  for (const row of sessions.list()) {
    await pointAtWorkspace(row).catch(err => console.warn(`[pidroid] workspace for session ${row.id}: ${err}`));
  }
  setState("workspaces", WORKSPACES_DIR);
  console.log(`[pidroid] sessions work in ${WORKSPACES_DIR}/<session id>`);
}

// Crash-loop guard: a run that keeps killing the process must not be resumed forever. A planned restart
// (restart_server) is not a crash: its runs resume, and it doesn't count towards the guard.
{
  const now = Date.now();
  const planned = now - Number(getState("planned_restart") ?? 0) < 60_000;
  setState("planned_restart", "0");
  const boots: number[] = JSON.parse(getState("boots") ?? "[]").filter((t: number) => now - t < 120_000);
  if (planned) {
    harness.resume(); // continue every run the previous process left unfinished
  } else {
    setState("boots", JSON.stringify([...boots, now].slice(-6)));
    if (boots.length >= 1) {
      console.warn(`[pidroid] ${boots.length} restart(s) in the last 2 minutes; aborting unfinished runs instead of resuming them`);
      for (const row of sessions.list()) await (await handleFor(row)).abort(context);
    } else {
      harness.resume();
    }
  }
}
console.log(`[pidroid] pi-durable agent ready (${AGENT_DB_PATH}), ${sessions.list().length} session(s)`);

// Live chat state for the UI: every commit (including throttled streaming partials) is pushed over the WebSocket.
let latestView: ChatView = buildChatView(undefined, models);
function chatPayload() {
  return {
    view: latestView,
    thinking: thinkingInfo(),
    model: `${pickDefaultModel().provider}/${pickDefaultModel().modelId}`,
    session: { id: current.id, title: current.title },
  };
}
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pendingValue: unknown;
let detachView: (() => void) | undefined;

async function attachView() {
  detachView?.();
  const view = await root.viewState(context);
  let active = true;
  const refresh = (value: unknown) => {
    if (!active) return;
    pendingValue = value;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      latestView = buildChatView(pendingValue, models);
      broadcast("agent_view", chatPayload());
    }, 50);
  };
  // Set the first view synchronously so a request right after a switch never sees the previous session's state.
  latestView = buildChatView((view as any).value ?? (view as any).get?.(), models);
  const unsubscribe = view.subscribe((value: unknown) => refresh(value));
  detachView = () => {
    active = false;
    (unsubscribe as any)?.();
    (view as any).dispose?.();
  };
}
await attachView();

async function switchTo(id: number) {
  const row = sessions.get(id);
  if (!row) throw new Error("No such session");
  current = row;
  root = await handleFor(row);
  setState("session", String(id));
  await attachView();
  broadcast("sessions_changed", {});
  broadcast("agent_view", chatPayload());
}

/** Sessions with a run in progress or queued input, from the harness's live work. */
async function busySessions(): Promise<Set<number>> {
  const live = await harness.inspect(context);
  return new Set(live.submissions.map((s) => Number(s.conversationId)));
}

async function deleteSession(id: number) {
  const row = sessions.get(id);
  if (!row) throw new Error("No such session");
  await (await handleFor(row)).abort(context).catch(() => {});
  sessions.remove(id);
  handles.delete(row.conversationId);
  if (current.id === id) {
    const next = sessions.list()[0] ?? (await createSession());
    await switchTo(next.id);
  } else {
    broadcast("sessions_changed", {});
  }
}

function answerText(entry: any): string {
  const message = entry?.model?.[0];
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("")
    .trim();
}

// Watch www directory for direct agent modifications
if (existsSync(WWW_DIR)) {
  try {
    const { watch } = await import("fs");
    watch(WWW_DIR, { recursive: true }, (eventType, filename) => {
      console.log(`[pidroid] Detected UI modification (${eventType}): ${filename}`);
      requestUiReload(filename);
    });
  } catch (err) {
    console.warn("[pidroid] File watcher warning:", err);
  }
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for real-time agent updates and UI hot-reload
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API Routes
    if (url.pathname === "/api/status") {
      const messageCount = db.query("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      return Response.json({
        status: "online",
        runtime: "bun",
        version: Bun.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: DB_PATH,
        messageCount: messageCount?.count ?? 0,
      });
    }

    if (url.pathname === "/api/messages" && req.method === "GET") {
      const messages = db.query("SELECT * FROM messages ORDER BY id ASC").all();
      return Response.json({ messages });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      return req.json().then(async (body: { message?: string }) => {
        const text = body.message?.trim();
        if (!text) {
          return Response.json({ error: "Message is required" }, { status: 400 });
        }

        // Store user message
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("user", text);
        broadcast("message", { role: "user", content: text });

        let replyText: string;
        const conv = root; // a session switch mid-run must not redirect this request
        const session = current;
        if (session.title === DEFAULT_TITLE) {
          sessions.rename(session.id, text.replace(/\s+/g, " ").slice(0, 48));
          current = sessions.get(session.id) ?? current;
          broadcast("sessions_changed", {});
        }
        sessions.touch(session.id);
        // Capture manual edits first so the turn commit holds only what the agent changed.
        await changes.snapshot("[edits] Changes made outside the agent").catch(() => {});
        try {
          // A message sent while the agent is working is "steered": it is placed after the current step (model response and its
        // tool calls) and joins the running work, instead of waiting for the entire run to finish.
        const submission = await conv.submit({ type: "input", content: text, whenBusy: "steer" } as any, context);
          const settled = await submission.wait(context);
          if (settled.status === "done" && settled.type === "input") {
            const answer = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
            replyText = answerText(answer) || "(no text in reply)";
          } else {
            replyText = `Agent could not answer: ${JSON.stringify(settled)}`;
          }
        } catch (err) {
          replyText = `Agent error: ${err instanceof Error ? err.message : String(err)}`;
        }
        const turnOid = await changes
          .snapshot(`[turn] ${text.replace(/\s+/g, " ").slice(0, 80)}\n\nsession: ${session.title}\nmodel: ${pickDefaultModel().provider}/${pickDefaultModel().modelId}`)
          .catch(() => null);
        if (turnOid) broadcast("changes", { oid: turnOid });
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("assistant", replyText);
        broadcast("message", { role: "assistant", content: replyText });

        return Response.json({ success: true, reply: replyText });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      const agent = pickDefaultModel();
      const fallback = defaultModel();
      return logins.providers().then(providers => {
        // Usable = signed-in providers, plus the anonymous OpenCode free tier.
        const usable = new Set(providers.filter(p => p.configured).map(p => p.id));
        usable.add("opencode");
        const names = new Map(models.getProviders().map(p => [p.id, p.name ?? p.id]));
        return Response.json({
          current: `${agent.provider}/${agent.modelId}`,
          default: `${fallback.provider}/${fallback.modelId}`,
          models: models.getModels()
            .filter(m => usable.has(m.provider) || (m.provider === agent.provider && m.id === agent.modelId))
            .map((m) => ({
              id: `${m.provider}/${m.id}`,
              name: m.name,
              provider: m.provider,
              providerName: names.get(m.provider),
              reasoning: m.reasoning,
              image: m.input.includes("image"),
              contextWindow: m.contextWindow,
            })),
        });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Picking a model in the chooser applies to the current session only. The default for new
    // sessions is set deliberately -- the chooser's star, or this route.
    if (url.pathname === "/api/model" && req.method === "POST") {
      return req.json().then(async (body: { model?: string }) => {
        const [provider, ...rest] = (body.model ?? "").split("/");
        const modelId = rest.join("/");
        if (!models.getModel(provider, modelId)) {
          return Response.json({ error: `Unknown model: ${body.model}` }, { status: 400 });
        }
        await root.configure({ model: { provider, modelId } }, context);
        sessions.setModel(current.id, `${provider}/${modelId}`);
        current = sessions.get(current.id) ?? current;
        await applyThinking();
        broadcast("agent_view", chatPayload());
        return Response.json({ success: true, current: body.model });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/model/default" && req.method === "POST") {
      return req.json().then((body: { model?: string }) => {
        const [provider, ...rest] = (body.model ?? "").split("/");
        const modelId = rest.join("/");
        if (!models.getModel(provider, modelId)) {
          return Response.json({ error: `Unknown model: ${body.model}` }, { status: 400 });
        }
        setState("model", `${provider}/${modelId}`);
        console.log(`[pidroid] default model is now ${provider}/${modelId}`);
        // The session on screen keeps its own model: setting a default is not a silent switch.
        return Response.json({ success: true, default: `${provider}/${modelId}` });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Re-fetch OpenCode free / Command Code catalogs ({ "providers": ["opencode"] } or omit for both).
    if (url.pathname === "/api/models/refresh" && req.method === "POST") {
      return req.json().catch(() => ({})).then(async (body: { providers?: string[] }) => {
        const result = await models.refresh({
          providers: body.providers ?? ["opencode", "commandcode"],
          signal: AbortSignal.timeout(15000),
          force: true,
        });
        return Response.json({
          aborted: result.aborted,
          errors: Object.fromEntries([...result.errors].map(([id, e]) => [id, e.message])),
        });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/commandcode/usage" && req.method === "GET") {
      return providerApiKey("commandcode")
        .then(key => commandCodeUsage(key))
        .then(text => Response.json({ usage: text }))
        .catch(err => Response.json({ error: String(err) }, { status: 502 }));
    }

    // --- Provider auth (OpenCode is anonymous and hidden) ---
    if (url.pathname === "/api/providers" && req.method === "GET") {
      return logins.providers()
        .then(providers => Response.json({
          providers: providers.map(p => ({ ...p, usage: p.configured && !!usageSources[p.id] })),
        }))
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Live usage for a signed-in provider: plan, credit windows and period totals.
    const usageRoute = url.pathname.match(/^\/api\/providers\/([^/]+)\/usage$/);
    if (usageRoute && req.method === "GET") {
      const providerId = decodeURIComponent(usageRoute[1]);
      const source = usageSources[providerId];
      if (!source) return Response.json({ error: `${providerId} does not report usage` }, { status: 400 });
      return providerApiKey(providerId)
        .then(key => {
          if (!key) throw new Error(`${providerId} is not signed in`);
          return source(key, AbortSignal.timeout(20_000));
        })
        .then(usage => Response.json({ usage }))
        .catch((err: Error) => Response.json({ error: err?.message ?? String(err) }, { status: 502 }));
    }

    const providerRoute = url.pathname.match(/^\/api\/providers\/([^/]+)\/(login|key|logout)$/);
    if (providerRoute && req.method === "POST") {
      const providerId = decodeURIComponent(providerRoute[1]);
      const action = providerRoute[2];
      return req.json().catch(() => ({})).then(async (body: { type?: "oauth" | "api_key"; key?: string }) => {
        if (action === "login") {
          return Response.json({ loginId: logins.start(providerId, body.type === "api_key" ? "api_key" : "oauth") });
        }
        if (action === "key") {
          await logins.saveApiKey(providerId, body.key ?? "");
        } else {
          await logins.logout(providerId);
        }
        broadcast("providers_changed", { providerId });
        return Response.json({ success: true });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    const loginRoute = url.pathname.match(/^\/api\/login\/([^/]+)\/(answer|cancel)$/);
    if (loginRoute && req.method === "POST") {
      const loginId = decodeURIComponent(loginRoute[1]);
      return req.json().catch(() => ({})).then((body: { promptId?: string; value?: string }) => {
        if (loginRoute[2] === "cancel") logins.cancel(loginId);
        else logins.answer(loginId, body.promptId ?? "", body.value ?? "");
        return Response.json({ success: true });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    // --- Self-modification ---
    if (url.pathname === "/api/reload" && req.method === "POST") {
      return loader.reload().then(r => Response.json(r)).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Extensions: the settings tab lists them and toggles each one. Turning one off stores the choice and
    // reloads in the same step, so what the list shows is what is actually installed.
    if (url.pathname === "/api/extensions" && req.method === "GET") {
      return Response.json({ extensions: loader.list() });
    }

    if (url.pathname === "/api/extensions/toggle" && req.method === "POST") {
      return req.json()
        .then((body: { file?: string; enabled?: boolean }) => {
          if (!body.file || !loader.list().some((e) => e.file === body.file)) throw new Error("No such extension file");
          setExtensionEnabled(body.file, body.enabled !== false);
          return loader.reload();
        })
        .then(reload => Response.json({ success: true, extensions: loader.list(), reload }))
        .catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      return preflight().then(problem => {
        if (problem) return Response.json({ error: `server.ts does not build:\n${problem}` }, { status: 409 });
        scheduleRestart(300);
        return Response.json({ success: true });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // --- Sessions ---
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return busySessions().then(busy => Response.json({
        current: current.id,
        sessions: sessions.list().map(r => ({ ...r, busy: busy.has(r.conversationId) })),
      })).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      return createSession()
        .then(async row => { await switchTo(row.id); return Response.json({ success: true, id: row.id }); })
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    const sessionRoute = url.pathname.match(/^\/api\/sessions\/(\d+)\/(switch|rename|delete)$/);
    if (sessionRoute && req.method === "POST") {
      const id = Number(sessionRoute[1]);
      return req.json().catch(() => ({})).then(async (body: { title?: string }) => {
        if (sessionRoute[2] === "switch") await switchTo(id);
        else if (sessionRoute[2] === "rename") {
          if (!sessions.get(id)) throw new Error("No such session");
          sessions.rename(id, body.title ?? "");
          if (current.id === id) current = sessions.get(id) ?? current;
          broadcast("sessions_changed", {});
          broadcast("agent_view", chatPayload());
        } else await deleteSession(id);
        return Response.json({ success: true, current: current.id });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    // --- Live chat ---
    if (url.pathname === "/api/view" && req.method === "GET") return Response.json(chatPayload());

    if (url.pathname === "/api/abort" && req.method === "POST") {
      return root.abort(context)
        .then(() => Response.json({ success: true }))
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/thinking" && req.method === "POST") {
      return req.json().then(async (body: { level?: string }) => {
        const info = thinkingInfo();
        if (!body.level || !(info.levels as string[]).includes(body.level)) {
          return Response.json({ error: `Unsupported level for this model. Choose one of: ${info.levels.join(", ")}` }, { status: 400 });
        }
        setState("thinking", body.level);
        sessions.setThinking(current.id, body.level);
        current = sessions.get(current.id) ?? current;
        await applyThinking();
        broadcast("agent_view", chatPayload());
        return Response.json({ success: true, thinking: thinkingInfo() });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // --- Change tracking ---
    if (url.pathname === "/api/changes" && req.method === "GET") {
      return changes.list(Number(url.searchParams.get("limit")) || 60)
        .then(entries => Response.json({ entries }))
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    const changeRoute = url.pathname.match(/^\/api\/changes\/([0-9a-f]{40})\/(files|diff|undo|restore)$/);
    if (changeRoute) {
      const [, oid, action] = changeRoute;
      const respond = (work: Promise<unknown>) =>
        work.then(result => {
          if (action === "undo" || action === "restore") broadcast("changes", {});
          return Response.json(result as object);
        }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
      if (action === "files" && req.method === "GET") return respond(changes.files(oid).then(files => ({ files })));
      if (action === "diff" && req.method === "GET") {
        return respond(changes.diff(oid, url.searchParams.get("path") ?? "").then(diff => ({ diff })));
      }
      if (action === "undo" && req.method === "POST") return respond(changes.undo(oid));
      if (action === "restore" && req.method === "POST") return respond(changes.restore(oid));
    }

    // Undo the newest change of any kind (undoing an undo redoes it). Also used by the native "Recover" menu.
    if (url.pathname === "/api/changes/undo-latest" && req.method === "POST") {
      return changes.undoLatest()
        .then(result => { broadcast("changes", {}); return Response.json(result); })
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Attachments from the composer's file picker. The Android picker hands the WebView a
    // content:// URI, so the bytes can be read without any storage permission; the app then
    // writes them itself, which is the only kind of file it can read back from shared
    // storage (other apps' files are EACCES). uploads/ is gitignored, so screenshots never
    // end up in a checkpoint. The returned path is absolute: the agent's working directory is its
    // own session workspace, not the app tree.
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const requested = (url.searchParams.get("name") || "attachment").replace(/[^\w.\- ]+/g, "_").trim().slice(-80);
      return req.arrayBuffer().then(async buf => {
        if (!buf.byteLength) return Response.json({ error: "Empty upload" }, { status: 400 });
        if (buf.byteLength > 24 * 1024 * 1024) return Response.json({ error: "File is larger than 24 MB" }, { status: 413 });
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const file = join(UPLOADS_DIR, `${Date.now()}-${requested || "attachment"}`);
        await Bun.write(file, buf);
        return Response.json({ path: file, size: buf.byteLength });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/files/write" && req.method === "POST") {
      return req.json().then((body: { path: string; content: string }) => {
        if (!body.path || body.content === undefined) {
          return Response.json({ error: "Path and content are required" }, { status: 400 });
        }
        const targetPath = join(APP_DIR, body.path);
        writeFileSync(targetPath, body.content, "utf-8");
        return Response.json({ success: true, path: targetPath });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/files/list" && req.method === "GET") {
      const relPath = url.searchParams.get("dir") || "www";
      const targetDir = join(APP_DIR, relPath);
      if (!existsSync(targetDir)) return Response.json({ files: [] });

      const files = readdirSync(targetDir).map(file => {
        const st = statSync(join(targetDir, file));
        return { name: file, isDirectory: st.isDirectory(), size: st.size };
      });
      return Response.json({ dir: relPath, files });
    }

    // The Files tab's tree: the whole harness in one request.
    //
    // The file set is deliberately the same one extensions/save-bundle.ts walks, so the tab shows
    // exactly what save_bundle would put in a tarball -- that is the tree a user needs to see to
    // judge a bundle. The skip lists below mirror SKIP_DIRS / SKIP_FILES / SKIP_SUFFIXES there (and
    // changes.ts keeps a third copy in its IGNORE), so keep them in step. Consequences worth knowing:
    // vendor/, fallback/ and .git are absent because they are never bundled, and so are auth.json and
    // the sqlite session databases; credentials and conversation history are never readable here.
    if (url.pathname === "/api/files/tree" && req.method === "GET") {
      const shipped = (() => {
        try {
          return JSON.parse(readFileSync(join(APP_DIR, ".shipped_manifest.json"), "utf-8")) as Record<string, string>;
        } catch {
          return {};
        }
      })();

      const isSkipped = (name: string) =>
        TREE_SKIP_FILES.has(name) || TREE_SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));

      // Counted as we walk rather than derived afterwards: the summary line is the only thing that
      // reads these, and re-scanning the finished tree to total them would walk it twice.
      // COUNT_KEY maps each status to its counter field -- the two are spelled differently
      // ("not-shipped" vs notShipped), so indexing counts[status] would silently create a
      // "not-shipped" key and leave the real counter at zero.
      const COUNT_KEY = { modified: "modified", "not-shipped": "notShipped", unchanged: "unchanged" } as const;
      const counts = { files: 0, modified: 0, notShipped: 0, unchanged: 0, totalBytes: 0 };

      type TreeNode = {
        name: string;
        path: string;
        dir: boolean;
        size: number;
        mtime: number;
        status: "modified" | "not-shipped" | "unchanged";
        children?: TreeNode[];
      };

      // withFileTypes keeps symlinks out of the recursion (entry.isDirectory() is false for a link),
      // so a self-referential link cannot spin this into an infinite walk.
      const walk = (rel: string): TreeNode[] => {
        const abs = rel ? join(APP_DIR, rel) : APP_DIR;
        let entries;
        try {
          entries = readdirSync(abs, { withFileTypes: true });
        } catch {
          return [];
        }
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue;
          if (!entry.isDirectory() && isSkipped(entry.name)) continue;
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          let size = 0;
          let mtime = 0;
          try {
            const st = statSync(join(APP_DIR, path));
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            continue; // vanished mid-walk (the agent rewrites files constantly)
          }
          const baseline = shipped[path];
          const node: TreeNode = {
            name: entry.name,
            path,
            dir: entry.isDirectory(),
            size,
            mtime,
            status:
              baseline === undefined ? "not-shipped" : baseline === sha256Hex(readFileSync(join(APP_DIR, path))) ? "unchanged" : "modified",
          };
          if (entry.isDirectory()) {
            node.children = walk(path);
          } else {
            counts[COUNT_KEY[node.status]]++;
            counts.files++;
            counts.totalBytes += size;
          }
          nodes.push(node);
        }
        // Folders before files, then case-insensitive name order: matches how a file tree reads.
        return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
      };

      const tree = walk("");

      // Shipped files that are gone from disk. save_bundle reports these in MANIFEST.json instead of
      // archiving them; showing them here keeps the two views honest about what was deleted.
      const present = new Set<string>();
      const markPresent = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          present.add(node.path);
          if (node.children) markPresent(node.children);
        }
      };
      markPresent(tree);
      const deleted = Object.keys(shipped)
        .filter((path) => !present.has(path) && !TREE_SKIP_DIRS.has(path.split("/")[0]) && !isSkipped(path))
        .sort();

      return Response.json({
        tree,
        deleted,
        counts,
        excluded: {
          dirs: [...TREE_SKIP_DIRS],
          files: [...TREE_SKIP_FILES],
          suffixes: TREE_SKIP_SUFFIXES,
        },
      });
    }

    // View one file from the tree. Guarded: the path must stay inside APP_DIR once resolved, and the
    // file must be small and text-ish -- this feeds a <pre>, and a 9 MB sqlite page or a PNG would
    // only stall the WebView. Skipped files stay unreadable here as well as unbundleable.
    if (url.pathname === "/api/files/read" && req.method === "GET") {
      const requested = url.searchParams.get("path") || "";
      const target = resolve(APP_DIR, requested);
      if (target !== APP_DIR && !target.startsWith(APP_DIR + "/")) {
        return Response.json({ error: "Path escapes the app directory" }, { status: 400 });
      }
      const name = target.slice(APP_DIR.length + 1);
      if (name && (TREE_SKIP_FILES.has(target.split("/").pop()!) || TREE_SKIP_SUFFIXES.some((s) => name.endsWith(s)))) {
        return Response.json({ error: "This file is never included in a bundle" }, { status: 403 });
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return Response.json({ error: "Not a file" }, { status: 404 });
      }
      const size = statSync(target).size;
      if (size > MAX_READ_BYTES) {
        return Response.json({ error: `Too large to preview (${(size / 1024).toFixed(0)} KB)`, path: name, size });
      }
      const buffer = readFileSync(target);
      // A NUL byte in the first block is the cheap binary test; the extension list is what actually
      // matters, and an .svg or .ts never contains one.
      if (buffer.subarray(0, 4096).includes(0)) {
        return Response.json({ error: "Binary file, no preview", path: name, size });
      }
      return Response.json({ path: name, size, content: buffer.toString("utf-8") });
    }

    // Static frontend files from www/
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = join(WWW_DIR, filePath);

    if (existsSync(fullPath)) {
      const file = Bun.file(fullPath);
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ event: "connected", payload: { version: Bun.version, port: PORT } }));
      ws.send(JSON.stringify({ event: "agent_view", payload: chatPayload(), timestamp: Date.now() }));
    },
    message(ws, message) {
      try {
        const data = JSON.parse(String(message));
        if (data.type === "ping") {
          ws.send(JSON.stringify({ event: "pong" }));
        }
      } catch {}
    },
    close(ws) {
      clients.delete(ws);
    }
  }
});

console.log(`[pidroid] HTTP & WebSocket Server running at http://127.0.0.1:${server.port}`);
