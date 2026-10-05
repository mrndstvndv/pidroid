/**
 * Turns pi-durable's committed conversation view into the compact JSON the chat UI renders:
 * transcript, the streaming partial (thinking / text / tool calls), tool output, the queue,
 * context usage and cache hit rate.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export type Block =
  | { type: "text"; text: string; /** Rendered markdown, added after the blocks are built. */ html?: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; args: unknown };

export interface ViewMessage {
  id: number;
  role: "user" | "assistant" | "tool";
  text?: string;
  blocks?: Block[];
  callId?: string;
  name?: string;
  isError?: boolean;
  stop?: string;
  error?: string;
  model?: string;
}

export interface ToolState {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
}

export interface ChatView {
  messages: ViewMessage[];
  /** The in-flight assistant response, if any. */
  live?: { blocks: Block[] };
  tools: ToolState[];
  busy: boolean;
  /** Messages waiting behind the current run. */
  queue: { id: number; text: string; mode: string }[];
  stats: {
    model?: string;
    contextTokens: number;
    contextWindow: number;
    /** Cache hit rate of the latest request, 0-100 (undefined before the first response). */
    cacheLast?: number;
    /** Cache hit rate over the whole active context. */
    cacheSession?: number;
    cost: number;
  };
}

const MAX_MESSAGES = 150;
const MAX_TOOL_TEXT = 6000;
const MAX_MESSAGES_HTML = 600_000;

/* ------------------------------------------------------------------ *
 * Markdown rendering (Bun built-in, with a safe fallback)
 * ------------------------------------------------------------------ */

/**
 * Bun ships a markdown renderer as `Bun.markdown.html`. Note that its sibling
 * `Bun.markdown.render` returns *terminal-rendered text* (markup stripped), not HTML,
 * so the result is validated before use. If nothing matches we fall back to a
 * minimal renderer and the UI sends no server HTML at all.
 */
type MarkdownFn = (text: string) => string;

function resolveMarkdown(): MarkdownFn | undefined {
  const b = (globalThis as any).Bun;
  const candidates: [string, unknown, unknown][] = [
    ["Bun.markdown.html", b?.markdown?.html, b?.markdown],
    ["Bun.markdown.render", b?.markdown?.render, b?.markdown],
    ["Bun.renderMarkdown", b?.renderMarkdown, b],
  ];
  for (const [name, fn, thisArg] of candidates) {
    if (typeof fn !== "function") continue;
    try {
      const out = (fn as (t: string) => unknown).call(thisArg, "# H\n\n**b**\n");
      if (typeof out === "string" && out.includes("<strong")) {
        console.log(`[pidroid] markdown: using ${name}`);
        return (t: string) => (fn as (t: string) => string).call(thisArg, t);
      }
      console.log(`[pidroid] markdown: ${name} rejected (returned ${typeof out === "string" ? JSON.stringify(out.slice(0, 40)) : typeof out})`);
    } catch (err) {
      console.warn(`[pidroid] markdown: ${name} threw`, err);
    }
  }
  console.warn("[pidroid] markdown: no Bun markdown renderer available, using the built-in fallback");
  return undefined;
}

const markdown = resolveMarkdown();

/** Escape for the few characters that would otherwise become markup in the fallback path. */
function escapeHtml(text: string): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal renderer used only when Bun has no markdown support: fenced code, inline code, bold. */
function fallbackMarkdown(text: string): string {
  return String(text)
    .split(/```/)
    .map((part, i) =>
      i % 2 === 1
        ? `<pre class="code">${escapeHtml(part.replace(/^[^\n]*\n/, ""))}</pre>`
        : escapeHtml(part).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"),
    )
    .join("");
}

function renderHtml(text: string): string {
  if (markdown) {
    try {
      const html = markdown(text);
      // A pathological message must not bloat every WebSocket push.
      if (typeof html === "string" && html.length <= MAX_MESSAGES_HTML) return html;
      return fallbackMarkdown(text);
    } catch {
      /* fall through to the built-in renderer */
    }
  }
  return fallbackMarkdown(text);
}

const htmlFor = (text: string): { html: string } => ({ html: renderHtml(text) });

/** Text blocks that are safe to pre-render: committed content, not the streaming partial. */
function committedBlocks(content: unknown): Block[] {
  return blocksOf(content).map((block) =>
    block.type === "text" && block.text.trim() ? { ...block, ...htmlFor(block.text) } : block,
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : ""))
    .join("");
}

function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function blocksOf(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const part of content as any[]) {
    if (part?.type === "text") out.push({ type: "text", text: part.text ?? "" });
    else if (part?.type === "thinking") out.push({ type: "thinking", text: part.thinking ?? "" });
    else if (part?.type === "toolCall") out.push({ type: "toolCall", id: part.id, name: part.name, args: part.arguments });
  }
  return out;
}

export function buildChatView(view: any, models: { getModel(p: string, id: string): Model<Api> | undefined }): ChatView {
  const entries: any[] = Array.isArray(view?.entries) ? view.entries : [];
  const live = view?.docs?.["pi.live"] ?? {};
  const inbox = view?.docs?.["pi.inbox"]?.items ?? [];

  const messages: ViewMessage[] = [];
  let lastAssistant: any;
  let promptTokens = 0;
  let cacheReadTokens = 0;
  let cost = 0;

  for (const entry of entries) {
    const message = entry?.model?.[0];
    if (!message) continue;
    if (entry.kind === "pi.user") {
      messages.push({ id: entry.id, role: "user", text: textOf(message.content) });
    } else if (entry.kind === "pi.assistant") {
      const usage = message.usage ?? {};
      messages.push({
        id: entry.id,
        role: "assistant",
        blocks: committedBlocks(message.content),
        stop: message.stopReason,
        error: message.errorMessage,
        model: `${message.provider}/${message.model}`,
      });
      if (usage.totalTokens > 0 || usage.input > 0) {
        lastAssistant = message;
        promptTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        cacheReadTokens += usage.cacheRead ?? 0;
        cost += usage.cost?.total ?? 0;
      }
    } else if (entry.kind === "pi.tool-result") {
      messages.push({
        id: entry.id,
        role: "tool",
        callId: message.toolCallId,
        name: message.toolName,
        isError: !!message.isError,
        text: clip(textOf(message.content)),
      });
    }
  }

  const partial = live?.generation?.message;
  const liveBlocks = partial ? blocksOf(partial.content) : undefined;

  const lastUsage = lastAssistant?.usage;
  const lastPrompt = lastUsage ? (lastUsage.input ?? 0) + (lastUsage.cacheRead ?? 0) + (lastUsage.cacheWrite ?? 0) : 0;
  const model = lastAssistant ? models.getModel(lastAssistant.provider, lastAssistant.model) : undefined;

  return {
    messages: messages.slice(-MAX_MESSAGES),
    live: liveBlocks ? { blocks: liveBlocks } : undefined,
    tools: ((live?.tools ?? []) as any[]).map((slot) => ({
      callId: slot.callId,
      name: slot.name,
      status: slot.status,
      output: slot.output ? clip(String(slot.output)) : undefined,
    })),
    busy: !!live?.run,
    queue: (inbox as any[])
      .filter((item) => item.mode !== "write")
      .map((item) => ({ id: item.id, text: clip(textOf(item.content), 200), mode: item.mode })),
    stats: {
      model: lastAssistant ? `${lastAssistant.provider}/${lastAssistant.model}` : undefined,
      contextTokens: lastUsage ? Math.max(lastUsage.totalTokens ?? 0, lastPrompt + (lastUsage.output ?? 0)) : 0,
      contextWindow: model?.contextWindow ?? 0,
      cacheLast: lastPrompt > 0 ? Math.round(((lastUsage.cacheRead ?? 0) / lastPrompt) * 100) : undefined,
      cacheSession: promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 100) : undefined,
      cost,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Thinking effort
 * ------------------------------------------------------------------ */

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** Levels the model accepts. `null` in thinkingLevelMap marks a level unsupported; levels that map to the same provider value are collapsed. */
export function supportedLevels(model: Model<Api> | undefined): Level[] {
  if (!model?.reasoning) return ["off"];
  const map = (model.thinkingLevelMap ?? {}) as Partial<Record<Level, string | null>>;
  const out: Level[] = [];
  let previous: string | undefined;
  for (const level of LEVELS) {
    const mapped = map[level];
    if (mapped === null) continue;
    if ((level === "xhigh" || level === "max") && typeof mapped !== "string") continue; // opt-in levels
    if (typeof mapped === "string" && mapped === previous) continue;
    previous = typeof mapped === "string" ? mapped : level;
    out.push(level);
  }
  return out.length ? out : ["off"];
}

/** The saved preference if the model supports it, else the closest supported level (preferring "medium"). */
export function clampLevel(preferred: string, levels: Level[]): Level {
  if ((levels as string[]).includes(preferred)) return preferred as Level;
  const want = LEVELS.indexOf(preferred as Level);
  return [...levels].sort((a, b) => Math.abs(LEVELS.indexOf(a) - want) - Math.abs(LEVELS.indexOf(b) - want))[0];
}
