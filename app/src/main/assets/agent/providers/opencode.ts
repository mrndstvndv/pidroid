/**
 * OpenCode Zen free models, ported from ~/.pi/personal/extensions/opencode-free.ts
 * to a pi-ai provider for the embedded pi-durable agent.
 *
 * The Zen free tier fingerprints the client: `User-Agent` must be
 * `opencode/<recent semver>` (else 426) and `x-opencode-session` must be a
 * canonical `ses_` id (else 403 FreeTierError). Headers are injected per
 * request by wrapping the API streams, so no host hook is needed.
 *
 * Muse models need the Responses API with `safety_identifier`, and Zen binds
 * reasoning `encrypted_content` to its caller, so reasoning items are never
 * replayed and never requested.
 *
 * Without OPENCODE_API_KEY the provider uses anonymous "public" access
 * (free models only).
 */

import {
  createProvider,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { randomBytes } from "node:crypto";

export const OPENCODE_PROVIDER_ID = "opencode";

const ZEN_BASE_URL = "https://opencode.ai/zen";
const ZEN_OPENAI_BASE_URL = `${ZEN_BASE_URL}/v1`;
const ZEN_MODELS_URL = `${ZEN_OPENAI_BASE_URL}/models`;
const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENCODE_LATEST_VERSION_URL = "https://registry.npmjs.org/opencode-ai/latest";
const DEFAULT_OPENCODE_CLIENT_VERSION = "1.18.31";
const MUSE_MAX_OUTPUT_TOKENS = 32000;
const FALLBACK_SAFETY_IDENTIFIER = "pi-opencode-free";
const GLOBAL_PROJECT_ID = "global";
const UNION_ALPHA_ID = "union-alpha";

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * IDs that list as *-free but are unusable.
 *
 * Verified against the live gateway on 2026-10-07:
 *   - mimo-v2.5-free: 410, "Model mimo-v2.5-free has been deprecated."
 *   - exo-free: gateway answers "Upstream request failed: Endpoint is unavailable."
 *     (the string comes from Zen's own upstream provider, not from us), i.e. the
 *     model is listed but has no route behind it yet. Same class of failure as
 *     the rest of this set, so it is hidden rather than offered and then failed.
 */
const DENYLISTED_FREE_IDS = new Set([
  "minimax-m2.5-free",
  "trinity-large-preview-free",
  "hy3-preview-free",
  "ling-2.6-flash-free",
  "qwen3.6-plus-free",
  "nemotron-3-super-free",
  "minimax-m3-free",
  "big-pickle",
  "laguna-s-2.1-free",
  "mimo-v2.5-free",
  "exo-free",
  UNION_ALPHA_ID,
]);

/** API claims more than testing allows; force text-only. */
const TEXT_ONLY_IDS = new Set<string>();

let opencodeClientVersion = DEFAULT_OPENCODE_CLIENT_VERSION;

/* ------------------------------------------------------------------ *
 * OpenCode-compatible ids
 * ------------------------------------------------------------------ */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `<prefix>_<6 byte timestamp hex><14 base62>` */
function generateId(prefix: "ses" | "usr"): string {
  const time = BigInt(Date.now()) * 0x1000n;
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) timeBytes[i] = Number((time >> BigInt(40 - 8 * i)) & 0xffn);
  const random = randomBytes(14);
  let tail = "";
  for (let i = 0; i < 14; i++) tail += BASE62[random[i] % 62];
  return `${prefix}_${timeBytes.toString("hex")}${tail}`;
}

const sessionId = generateId("ses");

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

type Thinking = NonNullable<Model<Api>["thinkingLevelMap"]>;

const GENERIC_THINKING: Thinking = {
  // Zen's validator now lists "none" (not "disabled") as the off value.
  off: "none",
  minimal: null,
  low: null,
  medium: "medium",
  high: "high",
  xhigh: "high",
};

const MUSE_THINKING: Thinking = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const DEEPSEEK_THINKING: Thinking = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

interface ModelSpec {
  name?: string;
  reasoning?: boolean;
  image?: boolean;
  context?: number;
  output?: number;
  zeroCost?: boolean;
}

function isMuse(id: string): boolean {
  return /^muse-/i.test(id);
}

function isFreeId(id: string): boolean {
  return /-free$/i.test(id);
}

function prettify(id: string): string {
  return id
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function buildModel(id: string, spec: ModelSpec = {}): Model<Api> {
  const base = {
    id,
    name: spec.name ?? prettify(id),
    provider: OPENCODE_PROVIDER_ID,
    reasoning: spec.reasoning ?? true,
    cost: { ...FREE_COST },
  };

  // Muse needs Responses API + safety_identifier (see streams()). Output cap is 32K.
  if (isMuse(id)) {
    return {
      ...base,
      api: "openai-responses",
      baseUrl: ZEN_OPENAI_BASE_URL,
      input: ["text", "image"],
      contextWindow: spec.context ?? 1048576,
      maxTokens: MUSE_MAX_OUTPUT_TOKENS,
      thinkingLevelMap: { ...MUSE_THINKING },
    } as Model<Api>;
  }

  if (/^deepseek-/i.test(id)) {
    return {
      ...base,
      api: "openai-completions",
      baseUrl: ZEN_OPENAI_BASE_URL,
      input: ["text"],
      contextWindow: spec.context ?? 200000,
      maxTokens: spec.output ?? 128000,
      thinkingLevelMap: { ...DEEPSEEK_THINKING },
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_completion_tokens",
        requiresReasoningContentOnAssistantMessages: true,
      },
    } as Model<Api>;
  }

  return {
    ...base,
    api: "openai-completions",
    baseUrl: ZEN_OPENAI_BASE_URL,
    input: spec.image && !TEXT_ONLY_IDS.has(id) ? ["text", "image"] : ["text"],
    contextWindow: spec.context ?? 128000,
    maxTokens: spec.output ?? 32000,
    thinkingLevelMap: { ...GENERIC_THINKING },
    compat: { supportsDeveloperRole: false, maxTokensField: "max_completion_tokens", thinkingFormat: "openai" },
  } as Model<Api>;
}

/**
 * Verified-live snapshot (2026-10-07) so the provider works offline.
 *
 * Note on credentials: without OPENCODE_API_KEY the provider uses the anonymous
 * "public" credential, and Zen now serves only space-bunny-free to it -- every
 * other *-free id answers 403 "OpenCode's free tier can only be used from within
 * OpenCode". A real Zen key (https://opencode.ai/auth) is what unlocks the rest.
 */
const STATIC_MODELS: [string, ModelSpec][] = [
  ["muse-spark-1.2-contributor-free", { name: "Muse Spark 1.2 Contributor Free" }],
  ["muse-spark-1.3-contributor-free", { name: "Muse Spark 1.3 Contributor Free" }],
  ["ling-3.0-flash-fin-free", { name: "Ling 3.0 Flash Fin Free", context: 262144, output: 32768 }],
  ["nemotron-3-ultra-free", { name: "Nemotron 3 Ultra Free", context: 1000000, output: 128000 }],
  ["nemotron-3.5-lightning-free", { name: "Nemotron 3.5 Lightning Free", context: 262144, output: 262144 }],
  ["longcat-2.5-preview-free", { name: "LongCat 2.5 Preview Free", image: true, context: 1000000, output: 131072 }],
  ["mimo-v2.6-flash-free", { name: "MiMo-V2.6-Flash Free", image: true, context: 200000, output: 32000 }],
  ["space-bunny-free", { name: "Space Bunny Free", image: true, context: 1048576, output: 524288 }],
];

const FALLBACK_MODELS = STATIC_MODELS.map(([id, spec]) => buildModel(id, spec));

/* ------------------------------------------------------------------ *
 * Discovery (Zen availability + models.dev specs)
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchJson(url: string, signal: AbortSignal, authorization?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  const response = await fetch(url, { signal, headers });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return (await response.json()) as unknown;
}

/** Keeps the spoofed User-Agent above the free tier's moving minimum; failures keep the old version. */
async function refreshClientVersion(signal: AbortSignal): Promise<void> {
  try {
    const payload = await fetchJson(OPENCODE_LATEST_VERSION_URL, signal);
    if (isRecord(payload) && typeof payload.version === "string" && /^\d+\.\d+\.\d+/.test(payload.version)) {
      opencodeClientVersion = payload.version;
    }
  } catch {}
}

function parseSpecs(payload: unknown): Map<string, ModelSpec> {
  const specs = new Map<string, ModelSpec>();
  if (!isRecord(payload) || !isRecord(payload.opencode) || !isRecord(payload.opencode.models)) return specs;
  for (const [id, raw] of Object.entries(payload.opencode.models)) {
    if (!isRecord(raw)) continue;
    const limit = isRecord(raw.limit) ? raw.limit : {};
    const modalities = isRecord(raw.modalities) && Array.isArray(raw.modalities.input) ? raw.modalities.input : [];
    const cost = isRecord(raw.cost) ? raw.cost : undefined;
    specs.set(id, {
      name: typeof raw.name === "string" ? raw.name : undefined,
      reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
      image: modalities.some((m) => typeof m === "string" && m.toLowerCase() === "image"),
      context: typeof limit.context === "number" ? limit.context : undefined,
      output: typeof limit.output === "number" ? limit.output : undefined,
      zeroCost: cost?.input === 0 && cost?.output === 0,
    });
  }
  return specs;
}

async function fetchFreeModels(signal: AbortSignal): Promise<Model<Api>[]> {
  await refreshClientVersion(signal);
  const zen = await fetchJson(ZEN_MODELS_URL, signal, "Bearer public");
  const ids =
    isRecord(zen) && Array.isArray(zen.data)
      ? zen.data
          .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined))
          .filter((id): id is string => !!id && isFreeId(id) && !DENYLISTED_FREE_IDS.has(id))
      : [];
  if (ids.length === 0) throw new Error("Zen catalog listed no free models");

  const specs = parseSpecs(await fetchJson(MODELS_DEV_URL, signal));
  const free = ids.filter((id) => specs.get(id)?.zeroCost);
  if (free.length === 0) throw new Error("models.dev listed no zero-cost free models");
  return free.map((id) => buildModel(id, specs.get(id))).sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ *
 * Request shaping
 * ------------------------------------------------------------------ */

/** CLI-identical fingerprint, regenerated per request. */
function fingerprint(): Record<string, string> {
  return {
    "User-Agent": `opencode/${opencodeClientVersion}`,
    "HTTP-Referer": "https://opencode.ai",
    "X-Title": "opencode",
    "x-opencode-client": "cli",
    "x-opencode-session": sessionId,
    "x-opencode-project": GLOBAL_PROJECT_ID,
    "x-opencode-request": generateId("usr"),
    "x-session-affinity": sessionId,
    "X-Session-Id": sessionId,
  };
}

/** Never replay stored reasoning items or request the encrypted blob (Zen 400s on it for Muse). */
function stripMuseReasoning(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  const next: Record<string, unknown> = { ...payload };
  let changed = false;
  if (Array.isArray(next.input)) {
    const filtered = next.input.filter((item) => !(isRecord(item) && item.type === "reasoning"));
    if (filtered.length !== next.input.length) {
      next.input = filtered;
      changed = true;
    }
  }
  if (Array.isArray(next.include)) {
    const filtered = next.include.filter((entry) => entry !== "reasoning.encrypted_content");
    if (filtered.length !== next.include.length) {
      next.include = filtered;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

function shape<O extends StreamOptions | SimpleStreamOptions>(model: Model<Api>, options: O | undefined): O {
  const base = (options ?? {}) as O;
  const headers = { ...fingerprint(), ...base.headers };
  if (!isMuse(model.id)) return { ...base, headers };

  const onPayload = base.onPayload;
  return {
    ...base,
    headers,
    samplingParams: {
      ...base.samplingParams,
      safety_identifier: base.sessionId ?? sessionId ?? FALLBACK_SAFETY_IDENTIFIER,
      include: [],
    },
    onPayload: async (payload: unknown, m: Model<Api>) => {
      const stripped = stripMuseReasoning(payload);
      const current = stripped ?? payload;
      const hooked = onPayload ? await onPayload(current, m) : undefined;
      return hooked ?? stripped;
    },
  };
}

function withFingerprint(streams: ProviderStreams): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options): AssistantMessageEventStream =>
      streams.stream(model, context, shape(model, options)),
    streamSimple: (model, context, options): AssistantMessageEventStream =>
      streams.streamSimple(model, context, shape(model, options)),
  };
}

/* ------------------------------------------------------------------ */

export function opencodeProvider() {
  const apiKey = process.env.OPENCODE_API_KEY?.trim() || "public";

  return createProvider({
    id: OPENCODE_PROVIDER_ID,
    name: "OpenCode Zen (free)",
    auth: {
      apiKey: {
        name: "OpenCode API key",
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key ?? apiKey },
          source: credential?.key || process.env.OPENCODE_API_KEY ? "OPENCODE_API_KEY" : "public",
        }),
      },
    },
    models: FALLBACK_MODELS,
    // Network discovery only runs on an explicit `models.refresh({ providers: ["opencode"] })`.
    fetchModels: async ({ signal, allowNetwork }) => (allowNetwork ? fetchFreeModels(signal) : FALLBACK_MODELS),
    api: {
      "openai-completions": withFingerprint(openAICompletionsApi()),
      "openai-responses": withFingerprint(openAIResponsesApi()),
      "anthropic-messages": withFingerprint(anthropicMessagesApi()),
    },
  });
}
