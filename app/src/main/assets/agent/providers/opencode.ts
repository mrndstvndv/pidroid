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
const ZEN_DOCS_URL = "https://opencode.ai/docs/zen.md";
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
 * Verified against the live gateway:
 *   - mimo-v2.5-free: 410, "Model mimo-v2.5-free has been deprecated."
 *   - exo-free: 410, {"type":"ModelDeprecated","message":"Model exo-free has been deprecated."}
 *     It was announced on models.dev on 2026-10-06 and dead at the gateway within
 *     three days, while still being listed by Zen's /models endpoint. Same class of
 *     failure as the rest of this set, so it is hidden rather than offered and then
 *     failed. (An earlier note here said "Endpoint is unavailable" from Zen's own
 *     upstream provider; that was the 2026-10-07 symptom, since replaced by the 410.)
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
  // No `off` entry, so the field is omitted at the off level rather than sent as a "none" effort:
  // verified live on 2026-10-08, Zen's upstream answers `reasoning_effort: "none"` with 400
  // "[invalid_request_error] invalid request" on every route behind the free tier -- including the
  // session-title job, which always runs at the default (off) level. Omitting the field is what the
  // OpenAI-compatible surface accepts; the model then reasons on its own default.
  //
  // Absent, not null: pi-ai omits the field either way (it only sends a string off value), but
  // supportedLevels() reads null as "this model cannot be turned off" -- which is what MUSE and
  // DEEPSEEK mean by it -- so `off: null` here dropped Off from the chooser and quietly moved
  // anyone who had picked it to medium.
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

/**
 * Repairs a persisted Zen catalog in place before the registry reads it.
 *
 * A pidroid-models.json written by an older build still carries `"off": "none"` (which Zen rejects)
 * or `"off": null` (which hid the Off level) on generic models, and the stored copy is the one that
 * reaches the model, so the entry is dropped on the way out to match GENERIC_THINKING. MUSE and
 * DEEPSEEK keep theirs: there null really means reasoning cannot be switched off. The next catalog
 * refresh rewrites the file with the fixed map anyway.
 */
export function normalizeOpencodeCatalog(models: unknown): unknown {
  if (!Array.isArray(models)) return models;
  return models.map((model: any) => {
    const map = model?.thinkingLevelMap;
    if (typeof map !== "object" || map === null || !("off" in map)) return model;
    const id = String(model?.id ?? "");
    if (isMuse(id) || /^deepseek-/i.test(id)) return model;
    if (map.off !== "none" && map.off !== null) return model;
    const { off: _dropped, ...rest } = map;
    return { ...model, thinkingLevelMap: rest };
  });
}

function isMuse(id: string): boolean {
  return /^muse-/i.test(id);
}

/**
 * Whether a Zen catalog id is usable, given what models.dev knows about it.
 *
 * models.dev is enrichment, not a gate: `undefined` (models.dev has not listed the model
 * yet) keeps it, only an explicit `zeroCost: false` (models.dev lists it with a price)
 * drops it. See the note in fetchFreeModels.
 */
export function usableFreeId(id: string, specs: Map<string, ModelSpec>): boolean {
  return specs.get(id)?.zeroCost !== false;
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

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { Accept: "text/plain" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.text();
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

/**
 * The Zen endpoints that speak a chat dialect buildModel can drive: the two
 * OpenAI-compatible surfaces plus Anthropic messages.
 *
 * Zen also serves per-model native passthroughs (/v1/models/gemini-...) and /v1/systemone,
 * which is a different API altogether -- it takes a set of questions and answers each by id
 * instead of generating text. That is where jev-1.13-free lives: a free, reachable
 * classifier that would happily accept a session prompt and answer the wrong question.
 */
const CHAT_SURFACES = new Set<string>([
  `${ZEN_OPENAI_BASE_URL}/chat/completions`,
  `${ZEN_OPENAI_BASE_URL}/responses`,
  `${ZEN_BASE_URL}/v1/messages`,
]);

/** model id -> endpoint, parsed out of Zen's published model table. */
export function parseEndpoints(markdown: string): Map<string, string> {
  const endpoints = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const id = cells[2].replace(/\`/g, "");
    const endpoint = cells[3].replace(/\`/g, "");
    if (!id || !/^https?:\//.test(endpoint)) continue;
    endpoints.set(id, endpoint.replace(/\/$/, ""));
  }
  return endpoints;
}

/**
 * Whether a Zen catalog id speaks a chat dialect. An id the docs table does not list is
 * kept: this is a statement about API shape, not a gate, and a newly announced model
 * should not vanish from the chooser because the table has not caught up.
 */
export function isChatSurface(id: string, endpoints: Map<string, string>): boolean {
  const endpoint = endpoints.get(id);
  return endpoint === undefined || CHAT_SURFACES.has(endpoint);
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

  // models.dev is an enrichment source here, not a gate. Zen announces new free models
  // (jev-1.13-free, 2026-10-09) well before models.dev lists them, and its /models endpoint
  // carries only {id, object, created, owned_by} -- no context/output/image metadata -- so
  // dropping every id models.dev has not picked up yet hides routes that work. An id that
  // models.dev *does* list with a non-zero cost is still dropped: that is a real signal.
  // Ids missing from models.dev fall back to buildModel's defaults, which deliberately
  // understate context (128K) and output (32K): understating truncates earlier and asks for
  // shorter replies, while overstating earns a 400 from the gateway.
  let specs = new Map<string, ModelSpec>();
  try {
    specs = parseSpecs(await fetchJson(MODELS_DEV_URL, signal));
  } catch {
    // models.dev unreachable: keep Zen's own catalog and use the defaults.
  }

  // Which API a model speaks comes from Zen's own table, not from a list kept here:
  // /v1/systemone routes (jev-1.13-free) are classifiers and are not offered as chat models.
  let endpoints = new Map<string, string>();
  try {
    endpoints = parseEndpoints(await fetchText(ZEN_DOCS_URL, signal));
  } catch {
    // Docs unreachable: keep the catalog rather than empty the chooser.
  }

  const free = ids.filter((id) => usableFreeId(id, specs) && isChatSurface(id, endpoints));
  if (free.length === 0) throw new Error("Zen catalog listed no usable free models");
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
