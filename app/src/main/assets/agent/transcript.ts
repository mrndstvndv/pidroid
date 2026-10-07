/**
 * Turning a conversation's log into something you can keep.
 *
 * The chat UI is a view: 150 messages, tool output clipped, thinking shown in a collapsed card.
 * That is the right shape for reading on a phone and the wrong one for a transcript, which has to
 * be complete and has to survive the session being deleted. So the export reads pi-durable's
 * entries directly instead of reusing chatview.ts -- no message cap, no clipping, and the same
 * code works for a session that is not the one on screen.
 *
 * Two renderings of the same parsed transcript: Markdown, to read, diff and paste into a document;
 * and JSON, for anything that wants to process it later. Parsing is separate from rendering so the
 * two can never disagree, and so the whole thing is testable without a conversation.
 *
 * Times are best-effort. pi-durable's entries carry no timestamps (timings.ts explains why), so the
 * wall clock comes from the stamps the server already keeps in the `timings` table: an assistant
 * message has the moment it committed, a tool result the moment its call finished, and a prompt
 * takes the start of the first block of the run it triggered. A conversation that was never opened
 * on this device has no stamps at all, and the transcript simply carries no times.
 *
 * A branch exports the history it inherited along with its own: pi-durable reads the parent's
 * entries through the fork link rather than copying them, so those messages are part of what this
 * session has actually said, and a transcript missing them would be misleading.
 */

/** Where the times came from: the session's `timings` rows, keyed exactly as timings.ts writes them. */
export type StampLookup = (key: string) => number | undefined;

export interface TranscriptMeta {
  title: string;
  sessionId: number;
  /** "provider/modelId" the session was started with, if it was pinned to one. */
  model?: string | null;
  thinking?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** Title of the session this was branched from, when it was. */
  branchedFrom?: string;
  /** Entry the branch was taken at. */
  forkEntryId?: number | null;
  /** Conversation id in pi-durable, which is what a fork points at. */
  conversationId?: number;
}

export interface TranscriptToolCall {
  id: string;
  name: string;
  args: unknown;
  /** How long the call took, from the block start to its result, where both are known. */
  ms?: number;
}

export interface TranscriptMessage {
  entryId: number;
  role: "user" | "assistant" | "tool" | "event";
  /** Epoch ms, where a stamp for this message exists. */
  at?: number;
  /** Epoch ms the assistant message was generated over, first block to commit. */
  ms?: number;
  /** User content: text runs, with image placeholders kept in place rather than dropped. */
  parts?: { text: string }[];
  images?: number;
  text?: string;
  /** Reasoning, kept apart from the answer so a reader can skip or drop it. */
  thinking?: string;
  toolCalls?: TranscriptToolCall[];
  /** Tool results. */
  toolName?: string;
  callId?: string;
  isError?: boolean;
  model?: string;
  stop?: string;
  error?: string;
  /** For `event` rows: what happened, already phrased. */
  note?: string;
  /** The streaming partial of a run that was still going when the export ran. */
  partial?: boolean;
}

export interface TranscriptOptions {
  /** Reasoning blocks. On by default: a transcript without it is not the whole conversation. */
  thinking?: boolean;
  /** Tool calls and their results. On by default: they are most of what happened. */
  tools?: boolean;
  stamps?: StampLookup;
  /** The in-flight assistant message, appended as a partial when the session was running. */
  live?: any;
}

const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const blocksOf = (content: unknown): any[] => (Array.isArray(content) ? content : []);

/** Text of a content block list, keeping images as counted placeholders (the bytes are not in the log). */
function userParts(content: unknown): { parts: { text: string }[]; images: number } | undefined {
  const blocks = blocksOf(content);
  if (!blocks.length) return undefined;
  const parts: { text: string }[] = [];
  let images = 0;
  let text = "";
  for (const block of blocks) {
    if (block?.type === "text" && block.text) {
      text += block.text;
    } else if (block?.type === "image") {
      images++;
      if (text) {
        parts.push({ text });
        text = "";
      }
      parts.push({ text: `[image ${images}]` });
    }
  }
  if (text) parts.push({ text });
  return { parts, images };
}

/**
 * Parse a conversation's entries into a flat, ordered transcript.
 *
 * Entries are append-only and immutable, so this walks the list once and never has to reconcile
 * anything: unlike the chat view there is no cached state to invalidate, which is what lets it
 * serve a session nobody has open.
 */
export function buildTranscript(entries: unknown, options: TranscriptOptions = {}): TranscriptMessage[] {
  const list = Array.isArray(entries) ? entries : [];
  const stamps = options.stamps;
  const out: TranscriptMessage[] = [];

  for (const raw of list as any[]) {
    const id = number(raw?.id) ?? 0;
    const kind = raw?.kind;
    const data = raw?.data;

    if (kind === "pidroid.model-change" || kind === "pidroid.thinking-change") {
      const from = kind === "pidroid.model-change" ? data?.fromModel : data?.fromLevel;
      const to = kind === "pidroid.model-change" ? data?.toModel : data?.toLevel;
      if (typeof from === "string" && typeof to === "string") {
        out.push({
          entryId: id,
          role: "event",
          at: stamps?.(`e:${id}`),
          note: kind === "pidroid.model-change" ? `Model changed: ${from} → ${to}` : `Thinking level: ${from} → ${to}`,
        });
      }
      continue;
    }

    const message = raw?.model?.[0];
    if (!message) continue;

    if (kind === "pi.user") {
      const content = userParts(message.content);
      const typed = typeof message.content === "string" ? message.content : content?.parts?.[0]?.text;
      out.push({
        entryId: id,
        role: "user",
        // No stamp of its own. The assistant message that answers it opens the run this prompt
        // started, and fills the time in below; a prompt nothing followed keeps none.
        at: undefined,
        parts: content?.parts ?? (typed ? [{ text: typed }] : undefined),
        images: content?.images,
      });
      continue;
    }

    if (kind === "pi.assistant") {
      const start = stamps?.(`b:${id}:0`);
      const end = stamps?.(`e:${id}`);
      let thinking: string | undefined;
      const texts: string[] = [];
      const toolCalls: TranscriptToolCall[] = [];
      blocksOf(message.content).forEach((block, index) => {
        if (block?.type === "text" && block.text) texts.push(block.text);
        else if (block?.type === "thinking" && block.thinking) thinking = `${thinking ? `${thinking}\n\n` : ""}${block.thinking}`;
        else if (block?.type === "toolCall") {
          // The block's stamp is when the call was emitted; its result, read further down the log,
          // is when it finished -- so the duration is only whole once both ends are known.
          toolCalls.push({
            id: String(block.id ?? ""),
            name: String(block.name ?? "tool"),
            args: block.arguments,
            ms: stamps?.(`b:${id}:${index}`),
          });
        }
      });
      // A tool call's duration is the gap between its block and the commit of its result, which is
      // only visible on the next pass over the log; anything still open here was never answered.
      const answered = toolCalls.map((call) => {
        const from = call.ms;
        const to = stamps?.(`r:${call.id}`);
        return to !== undefined && from !== undefined && to > from ? { ...call, ms: to - from } : { ...call, ms: undefined };
      });
      // This run's first block is the moment the prompt above was answered from, so it is also
      // when that prompt was sent -- the only place in the log where a prompt's clock survives.
      const prompt = out[out.length - 1];
      if (prompt?.role === "user" && prompt.at === undefined && start !== undefined) prompt.at = start;
      out.push({
        entryId: id,
        role: "assistant",
        at: end ?? start,
        ms: start !== undefined && end !== undefined && end > start ? end - start : undefined,
        text: texts.join("\n\n") || undefined,
        thinking: options.thinking === false ? undefined : thinking,
        toolCalls: options.tools === false ? undefined : answered,
        model: message.provider || message.model ? `${message.provider}/${message.model}` : undefined,
        stop: message.stopReason ?? undefined,
        error: message.errorMessage ?? undefined,
      });
      continue;
    }

    if (kind === "pi.tool-result" && options.tools !== false) {
      const callId = String(message.toolCallId ?? "");
      const text = blocksOf(message.content)
        .map((block: any) => (block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[image]" : ""))
        .join("");
      const ended = stamps?.(`r:${callId}`);
      out.push({
        entryId: id,
        role: "tool",
        at: ended,
        callId,
        toolName: message.toolName ? String(message.toolName) : undefined,
        isError: !!message.isError,
        text,
      });
    }
  }

  // A run that was still going when the export was taken: its committed messages are already in
  // the log, so only the uncommitted tail is added, and it says so rather than passing for final.
  const live = options.live?.generation?.message;
  if (live && blocksOf(live.content).length) {
    let text = "";
    let thinking: string | undefined;
    for (const block of blocksOf(live.content)) {
      if (block?.type === "text") text += block.text ?? "";
      else if (block?.type === "thinking" && options.thinking !== false) thinking = `${thinking ? `${thinking}\n\n` : ""}${block.thinking}`;
    }
    if (text.trim() || thinking?.trim()) {
      out.push({
        entryId: 0,
        role: "assistant",
        partial: true,
        text: text.trim() || undefined,
        thinking,
        model: live.provider ? `${live.provider}/${live.model}` : undefined,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

/** A fence long enough to contain the text it wraps: one backtick longer than the longest run inside. */
function fence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

const fenced = (text: string, lang = ""): string => {
  const mark = fence(text);
  return `${mark}${lang}\n${text.replace(/\n+$/, "")}\n${mark}`;
};

/** "3.1s" / "1m 04s" / "840ms" -- a duration you can read at a glance. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(Math.round(seconds - m * 60)).padStart(2, "0")}s`;
}

function stamp(at: number | undefined): string {
  if (at === undefined) return "";
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface TranscriptCounts {
  user: number;
  assistant: number;
  toolCalls: number;
  events: number;
}

export function countMessages(messages: TranscriptMessage[]): TranscriptCounts {
  const counts: TranscriptCounts = { user: 0, assistant: 0, toolCalls: 0, events: 0 };
  for (const message of messages) {
    if (message.role === "user") counts.user++;
    else if (message.role === "assistant") counts.assistant++;
    else if (message.role === "tool") counts.toolCalls++;
    else counts.events++;
  }
  return counts;
}

const roleHeading = (message: TranscriptMessage): string => {
  if (message.role === "user") return "You";
  return `Assistant${message.model ? ` · ${message.model}` : ""}`;
};

/**
 * Markdown rendering. Headings are level 2 per message so the file has a real outline (an
 * assistant's own `##` inside a fenced block stays inside it), and every fence is sized to its
 * contents, because tool output that itself contains a fence is the normal case here, not an edge
 * one.
 */
export function transcriptToMarkdown(messages: TranscriptMessage[], meta: TranscriptMeta): string {
  const counts = countMessages(messages);
  const lines: string[] = [`# ${meta.title}`, ""];
  const facts: string[] = [];
  if (meta.model) facts.push(`Model: \`${meta.model}\``);
  if (meta.thinking) facts.push(`Thinking: ${meta.thinking}`);
  if (meta.createdAt) facts.push(`Started: ${stamp(meta.createdAt)}`);
  if (meta.updatedAt) facts.push(`Last active: ${stamp(meta.updatedAt)}`);
  if (meta.branchedFrom) facts.push(`Branched from: ${meta.branchedFrom}${meta.forkEntryId ? ` (at entry ${meta.forkEntryId})` : ""}`);
  facts.push(`Messages: ${counts.user} from you, ${counts.assistant} from the assistant${counts.toolCalls ? `, ${counts.toolCalls} tool results` : ""}`);
  lines.push(...facts.map(f => `- ${f}`), "", "---", "");

  for (const message of messages) {
    if (message.role === "event") {
      lines.push(`*${message.note}${message.at ? ` — ${stamp(message.at)}` : ""}*`, "");
      continue;
    }

    // A tool result belongs to the assistant message that called it, so it stays inside that
    // section as a bold line rather than becoming a sibling of it in the outline.
    if (message.role === "tool") {
      const failed = message.isError ? " · failed" : "";
      lines.push(`**Result · \`${message.toolName ?? "tool"}\`**${failed}${message.at ? ` · ${stamp(message.at)}` : ""}`, "");
      // Tool output is verbatim, so it goes in a fence sized to its contents -- it very often
      // contains fences of its own (a file listing, a markdown excerpt, another transcript).
      lines.push(fenced(message.text?.trimEnd() || "*(no output)*"), "");
      continue;
    }

    const duration = message.ms !== undefined ? ` · ${formatDuration(message.ms)}` : "";
    lines.push(`## ${roleHeading(message)}${message.at ? ` · ${stamp(message.at)}` : ""}${duration}`, "");

    if (message.role === "user") {
      const body = message.parts?.map(p => p.text).join("\n\n");
      lines.push(body?.trim() || "*(empty prompt)*", "");
      continue;
    }

    if (message.thinking?.trim()) {
      // Blockquoted, so it stays visually separate from the answer and a reader can strip it.
      lines.push("> **Thinking**", ...message.thinking.trim().split("\n").map(l => `> ${l}`), "");
    }
    if (message.text?.trim()) lines.push(message.text.trim(), "");

    for (const call of message.toolCalls ?? []) {
      const took = message.toolCalls && call.ms !== undefined ? ` · ${formatDuration(call.ms)}` : "";
      let args: string;
      try {
        args = JSON.stringify(call.args ?? {}, null, 2);
      } catch {
        args = String(call.args);
      }
      lines.push(`**Tool call · \`${call.name}\`**${took}`, "", fenced(args, "json"), "");
    }

    if (message.error) lines.push(`**Error:** ${message.error}`, "");
    else if (message.stop && message.stop !== "stop") lines.push(`*(stopped: ${message.stop})*`, "");
    if (message.partial) lines.push("*(still streaming when this was exported)*", "");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function transcriptToJson(messages: TranscriptMessage[], meta: TranscriptMeta): string {
  return `${JSON.stringify(
    {
      meta: { ...meta, exportedAt: new Date().toISOString() },
      counts: countMessages(messages),
      messages,
    },
    null,
    2,
  )}\n`;
}

/** `pidroid-<title>-20261007-2231`, safe on every filesystem and in every share sheet. */
export function transcriptFileName(title: string, when = new Date()): string {
  const slug = String(title)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `pidroid-${slug}-${stamp}`;
}