/**
 * Wall-clock timings for the chat view: how long a thought, a tool call and a whole assistant
 * message took.
 *
 * pi-durable's view carries no timestamps -- `entries` are an append-only log and the only
 * thing that grows in real time is `pi.live`'s streaming partial. So the server stamps what it
 * sees: every push notes the wall clock, and the first time a block shows up inside the partial
 * its start is recorded. When that assistant message commits, the staged starts are handed to
 * the committed entry ids, which is what the UI finally renders durations from.
 *
 * The stamps live in SQLite (keyed by session + log id) so the numbers survive a server restart,
 * a reload or a session switch: a thought that took 90 seconds still says 90 seconds afterwards.
 */

import type { Database } from "bun:sqlite";

/** Resolves a stamp key to an epoch-ms timestamp, or undefined when it was never recorded. */
export type TimingLookup = (key: string) => number | undefined;

/** First time block `index` of assistant message `entryId` was seen. */
export const blockStartKey = (entryId: number, index: number) => `b:${entryId}:${index}`;
/** When the generation of assistant message `entryId` was committed. */
export const messageEndKey = (entryId: number) => `e:${entryId}`;
/** When the result of tool call `callId` was committed, i.e. when the tool stopped running. */
export const toolEndKey = (callId: string) => `r:${callId}`;
/** When the current run started; one per session, dropped as soon as the run is over. */
export const RUN_KEY = "run";

/** How long stamps are allowed to sit in memory before they are written. */
const FLUSH_MS = 2000;

function blockCount(content: unknown): number {
  return Array.isArray(content) ? content.length : 0;
}

/**
 * Per-session stamp store. One instance per open session; the stamps it needs for an older
 * session are already in the database, so switching back and forth is free.
 */
export class Timings {
  /** Insert-if-absent: the first sighting is the truth, later pushes must not move it. */
  #mem = new Map<string, number>();
  /** Every entry id of the current view, used to prune the table and to spot new log lines. */
  #live = new Set<string>();
  /** Entry ids already folded in. The log is append-only; this set is only reconciled when its
   *  prefix changes, rather than scanned on every streaming update. */
  #seen = new Set<string>();
  #entryCount = 0;
  #lastEntryId: string | undefined;
  /** Start times of the blocks of the message currently streaming, in order. */
  #staged: number[] | undefined;
  #dirty = false;
  /** Whether the log has been read once. The first read only catches up on what the database
   *  already describes, so it must not act as if each prompt in it had just arrived. */
  #caughtUp = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private db: Database, private sessionId: number) {
    for (const row of db
      .query("SELECT key, at FROM timings WHERE session = ?")
      .all(sessionId) as { key: string; at: number }[])
      this.#mem.set(row.key, row.at);
  }

  lookup: TimingLookup = (key) => this.#mem.get(key);

  /** Start times of the blocks of the message currently streaming, in order. */
  liveStarts(): number[] | undefined {
    return this.#staged?.length ? [...this.#staged] : undefined;
  }

  /**
   * Fold one view push into the stamps. `pi-durable` appends committed entries and puts streaming
   * partials in `pi.live`, so the normal push only needs to inspect the new log suffix. If the
   * prefix changes (a replacement or a trimmed view), rebuild the live-key set and reconcile ids.
   */
  stamp(value: unknown, now = Date.now()) {
    const view = value as any;
    const entries: any[] = Array.isArray(view?.entries) ? view.entries : [];
    const live = view?.docs?.["pi.live"];
    const content = Array.isArray(live?.generation?.message?.content)
      ? (live.generation.message.content as unknown[])
      : undefined;

    const running = !!live?.run || !!content;
    const prefixMatches = entries.length >= this.#entryCount && (
      this.#entryCount === 0 || String(entries[this.#entryCount - 1]?.id) === this.#lastEntryId
    );
    const start = prefixMatches ? this.#entryCount : 0;
    const present = prefixMatches ? undefined : new Set<string>();
    if (!prefixMatches) this.#live.clear();

    // 1. Fold new entries, in order, while adding their keys to the live set. On ordinary stream
    // updates this is an empty loop; no full-log scan or fresh Set allocation is needed.
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      const id = String(entry?.id);
      present?.add(id);
      const kind = entry?.kind;
      if (!this.#seen.has(id)) {
        this.#seen.add(id);
        if (kind === "pi.assistant") {
          const n = blockCount(entry?.model?.[0]?.content);
          for (let b = 0; b < n; b++) {
            const blockStart = this.#staged?.shift();
            // No staged start means this block was already finished when we first looked at the
            // run (a reload mid-turn); better to show nothing than a wrong 0s.
            if (blockStart !== undefined) this.#set(blockStartKey(entry.id, b), blockStart);
          }
          this.#set(messageEndKey(entry.id), now);
        } else if (kind === "pi.tool-result") {
          const callId = entry?.model?.[0]?.toolCallId;
          if (callId) this.#set(toolEndKey(callId), now);
        } else if (kind === "pi.user" && this.#caughtUp) {
          // A new prompt closes the previous run: its partial is gone and nothing staged applies.
          // Not on the first read: there every prompt is old news, and the latest one is the run
          // still going, whose start was just loaded from the database. Dropping it here restarted
          // the run clock at zero each time a running session was opened again.
          this.#staged = undefined;
          this.#mem.delete(RUN_KEY);
          this.#dirty = true;
        }
      }

      if (kind === "pi.assistant") {
        this.#live.add(messageEndKey(entry.id));
        for (let b = 0, n = blockCount(entry?.model?.[0]?.content); b < n; b++) {
          this.#live.add(blockStartKey(entry.id, b));
        }
      } else if (kind === "pi.tool-result") {
        const callId = entry?.model?.[0]?.toolCallId;
        if (callId) this.#live.add(toolEndKey(callId));
      }
    }

    // On a changed prefix, the entries currently present are the authority for pruning. New
    // append-only pushes do not need this pass: every earlier id is still present by definition.
    if (present) {
      for (const id of [...this.#seen]) if (!present.has(id)) this.#seen.delete(id);
    }

    // After the log pass, which clears the previous run on a new prompt: a run that is already
    // live gets its start stamped now, an idle session gets the key dropped.
    if (running && !this.#mem.has(RUN_KEY)) this.#set(RUN_KEY, now);
    if (!running && this.#mem.delete(RUN_KEY)) this.#dirty = true;

    if (content) {
      this.#staged ??= [];
      for (let i = this.#staged.length; i < content.length; i++) this.#staged.push(now);
    }

    if (running) this.#live.add(RUN_KEY);
    else this.#live.delete(RUN_KEY);
    this.#caughtUp = true;
    this.#entryCount = entries.length;
    this.#lastEntryId = entries.length ? String(entries[entries.length - 1]?.id) : undefined;
    this.#scheduleFlush();
  }

  #set(key: string, at: number) {
    if (this.#mem.has(key)) return;
    this.#mem.set(key, at);
    this.#dirty = true;
  }

  #scheduleFlush() {
    if (this.#timer || !this.#dirty) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, FLUSH_MS);
  }

  /** Write pending stamps and drop the ones the view no longer references. */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const rows = [...this.#mem];
    if (rows.length) {
      const insert = this.db.prepare("INSERT OR IGNORE INTO timings (session, key, at) VALUES (?, ?, ?)");
      this.db.transaction(() => {
        for (const [key, at] of rows) insert.run(this.sessionId, key, at);
      })();
    }
    this.#dirty = false;
    const stale = [...this.#mem.keys()].filter((key) => !this.#live.has(key));
    if (stale.length) {
      const drop = this.db.prepare("DELETE FROM timings WHERE session = ? AND key = ?");
      this.db.transaction(() => {
        for (const key of stale) drop.run(this.sessionId, key);
      })();
      for (const key of stale) this.#mem.delete(key);
    }
  }

  /** Persist immediately -- used when the session is about to be left behind. */
  close() {
    this.flush();
  }
}