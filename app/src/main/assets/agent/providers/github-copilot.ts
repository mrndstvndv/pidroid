/**
 * GitHub Copilot sign-in for the embedded agent.
 *
 * Why this file exists: the shipped vendor bundle (@earendil-works/pi-ai) resolves
 * every subscription login through a runtime import of the provider's OAuth module
 * (`import("./github-copilot.js")` resolved next to vendor/pi-ai-providers-all.js).
 * None of those modules were packaged into vendor/, so tapping "Sign in with GitHub
 * Copilot" (and the same for Anthropic, OpenAI Codex, ChatGPT, OpenRouter, Kimi,
 * Meta, xAI and Radius) died with "Cannot find module './<provider>.js'". vendor/ is
 * generated and not ours to edit, so the fix is to re-register the provider with a
 * login flow we own; everything else (model catalog, per-API streams, the Copilot
 * editor headers the API clients add) stays the built-in provider's.
 *
 * The flow is GitHub's own device code flow with VS Code Copilot's public OAuth
 * client id -- the same one Copilot Chat itself uses, so the resulting GitHub
 * token is one of the apps allowed to mint Copilot API tokens. The GitHub token is
 * then exchanged for a short-lived (30 min) Copilot session token; the session
 * token is what pi-ai hands to the API clients as the bearer key, and it is
 * refreshed from the GitHub token in the background.
 */

export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";

/** VS Code Copilot Chat's public OAuth app; the only client id allowlisted for copilot_internal. */
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/** Kept in step with the User-Agent/editor headers in the bundled Copilot model catalog. */
const CLIENT_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/* ------------------------------------------------------------------ *
 * Credential
 * ------------------------------------------------------------------ */

interface CopilotCredential {
  type: "oauth";
  /** Long-lived-ish GitHub OAuth token from the device flow; used to mint new session tokens. */
  githubToken: string;
  /** Short-lived Copilot session token, sent as the bearer key. */
  token: string;
  /** Epoch ms, as pi-ai expects. */
  expires: number;
  endpoints?: { api?: string };
  /** Learned from Copilot's "not available for integrator" error; drives the built-in filterModels. */
  availableModelIds?: string[];
}

/** Ask for a fresh Copilot session token using the stored GitHub token. */
async function exchangeSessionToken(githubToken: string, signal?: AbortSignal): Promise<CopilotCredential> {
  signal?.throwIfAborted();
  const response = await fetch(COPILOT_TOKEN_URL, {
    headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${githubToken}` },
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as {
    token?: string;
    expires_at?: number;
    endpoints?: { api?: string };
    message?: string;
  };
  if (!response.ok || !body.token) {
    // A GitHub token that no longer works (device tokens are valid ~8h and cannot be
    // renewed without the user) is the common case here, so say so plainly.
    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitHub rejected the Copilot token exchange (${response.status}). Sign in to GitHub Copilot again.`);
    }
    throw new Error(`Copilot token exchange failed (${response.status}): ${body.message ?? "no token returned"}`);
  }
  return {
    type: "oauth",
    githubToken,
    token: body.token,
    expires: (body.expires_at ?? Math.floor(Date.now() / 1000) + 1800) * 1000,
    endpoints: body.endpoints,
  };
}

/* ------------------------------------------------------------------ *
 * Device code flow
 * ------------------------------------------------------------------ */

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCode> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: CLIENT_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as Partial<DeviceCode> & { error?: string };
  if (!response.ok || !body.device_code) {
    throw new Error(`GitHub refused to start a device sign-in (${response.status})${body.error ? `: ${body.error}` : ""}`);
  }
  return body as DeviceCode;
}

/** Sleep that rejects as soon as the sign-in is cancelled. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const POLL_ERRORS: Record<string, string> = {
  access_denied: "GitHub sign-in was denied.",
  expired_token: "The GitHub sign-in code expired before it was approved. Start the sign-in again.",
  incorrect_device_code: "GitHub rejected the sign-in code. Start the sign-in again.",
  unauthorized_client: "GitHub rejected the Copilot client id for this app.",
};

async function pollForGitHubToken(device: DeviceCode, interaction: { signal?: AbortSignal; notify?: (event: unknown) => void }): Promise<string> {
  let interval = Math.max(device.interval || 5, 5);
  const deadline = Date.now() + Math.max(device.expires_in - 30, 30) * 1000;
  let announced = false;

  for (;;) {
    interaction.signal?.throwIfAborted();
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: interaction.signal,
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (body.access_token) return body.access_token;

    if (body.error === "authorization_pending") {
      if (!announced) {
        announced = true;
        interaction.notify?.({
          type: "progress",
          message: "Waiting for you to approve the sign-in on GitHub, then return here.",
        });
      }
    } else if (body.error === "slow_down") {
      interval += 5;
    } else {
      const detail = body.error_description || body.error;
      throw new Error(POLL_ERRORS[body.error ?? ""] ?? `GitHub sign-in failed${detail ? `: ${detail}` : ""}`);
    }

    if (Date.now() >= deadline) throw new Error(POLL_ERRORS.expired_token);
    await delay(interval * 1000, interaction.signal);
  }
}

/* ------------------------------------------------------------------ *
 * The OAuth plug-in pi-ai expects
 * ------------------------------------------------------------------ */

export const copilotOAuth = {
  name: "GitHub Copilot",
  isSubscription: true,
  loginLabel: "Sign in with GitHub",

  async login(interaction: { signal?: AbortSignal; notify?: (event: unknown) => void }) {
    const device = await requestDeviceCode(interaction.signal);
    interaction.notify?.({
      type: "device_code",
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: device.expires_in,
      interval: device.interval,
    });
    const githubToken = await pollForGitHubToken(device, interaction);
    interaction.notify?.({ type: "progress", message: "Signed in to GitHub, fetching your Copilot token..." });
    const credential = await exchangeSessionToken(githubToken, interaction.signal);
    interaction.notify?.({
      type: "info",
      message: `Copilot access granted (valid until ${new Date(credential.expires).toLocaleTimeString()}).`,
    });
    return credential;
  },

  async refresh(credential: CopilotCredential, signal?: AbortSignal) {
    // pi-ai only calls this once the session token is close to expiry, so one
    // exchange is enough; a GitHub token that has itself expired throws above and
    // the UI asks the user to sign in again. Keep the learned model list.
    const refreshed = await exchangeSessionToken(credential.githubToken, signal);
    return credential.availableModelIds ? { ...refreshed, availableModelIds: credential.availableModelIds } : refreshed;
  },

  /**
   * Returns the request auth itself (not a resolution): pi-ai wraps this as
   * `{ auth: await oauth.toAuth(credential), source: "OAuth" }`.
   */
  async toAuth(credential: CopilotCredential) {
    return { apiKey: credential.token };
  },
};

/* ------------------------------------------------------------------ *
 * Available models
 * ------------------------------------------------------------------ */

/**
 * GitHub only ever tells us which models this account may use inside the 400 it
 * returns for a model the "vscode-chat" integrator cannot serve ("The requested
 * model is not available for integrator ... Available models: [...]"), and there is
 * no endpoint that lists them. So we learn the list from that error the first time a
 * user picks a model their plan does not have, stash it on the credential as
 * `availableModelIds`, and let the built-in provider's own filterModels use it: the
 * picker then only offers models that actually work, for this account.
 */
const AVAILABLE_IN_ERROR = /Available models:\s*\[([^\]]*)\]/;

function parseAvailableModelIds(errorMessage: unknown): string[] | undefined {
  if (typeof errorMessage !== "string") return undefined;
  const match = AVAILABLE_IN_ERROR.exec(errorMessage);
  if (!match) return undefined;
  const ids = match[1]
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

/** Remember the last list handed to the callback so auth.json is written only on a change. */
let lastLearned: string[] | undefined;

type Learned = (ids: string[]) => void | Promise<void>;

/** Swap a stream's assistant message for a copy with a readable error, and learn from it. */
function rewrite(message: any, learn: Learned): any {
  const ids = parseAvailableModelIds(message?.errorMessage);
  if (!ids) return message;
  if (JSON.stringify(ids) !== JSON.stringify(lastLearned)) {
    lastLearned = ids;
    void Promise.resolve(learn(ids)).catch(() => {});
  }
  if (message.errorMessage === FRIENDLY_ERROR) return message;
  return { ...message, errorMessage: FRIENDLY_ERROR };
}
const FRIENDLY_ERROR =
  "This model is not enabled for your GitHub Copilot plan. Available models have been " +
  "added to the model list -- pick one of those (sign out and back in if the list is stale).";

/**
 * Watch a provider stream without changing its behaviour: proxy everything to the
 * inner stream, tap each assistant message on the way out.
 */
function tap(inner: any, learn: Learned): any {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          for await (const event of target as AsyncIterable<any>) {
            // A failed stream delivers the assistant message either as `partial` or,
            // for a hard error, as `error` on the event itself.
            if (event?.partial) yield { ...event, partial: rewrite(event.partial, learn) };
            else if (event?.type === "error" && event.error) yield { ...event, error: rewrite(event.error, learn) };
            else yield event;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "result") {
        return async () => rewrite(await value.call(target), learn);
      }
      return value.bind(target);
    },
  });
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/**
 * The built-in GitHub Copilot provider with its (unresolvable) OAuth plug-in swapped
 * for the one above, plus a tap that learns the account's available models. Everything
 * else -- model catalog, per-API streams, the Copilot editor headers the clients add --
 * is the built-in provider's own, so this returns the same provider object with a
 * different `auth`. `learn` is called with the available model ids when we discover
 * them; the caller persists them onto the stored credential.
 */
export function withCopilotOAuth<T extends { auth: object }>(base: T, learn: Learned): T {
  return {
    ...base,
    auth: { ...(base.auth as Record<string, unknown>), oauth: copilotOAuth },
    stream: (model: any, context: any, options: any) => tap(base.stream(model, context, options), learn),
    streamSimple: (model: any, context: any, options: any) => tap(base.streamSimple(model, context, options), learn),
  };
}