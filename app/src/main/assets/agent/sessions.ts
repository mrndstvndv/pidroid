/**
 * Session registry. pi-durable keeps any number of conversations in one storage but has no notion of titles,
 * recency or deletion, so the app tracks those itself. Deleting a session stops its run and drops the row for
 * good -- pi-durable has no API to remove a conversation, so its transcript is deleted by purge.ts, which
 * writes the SQL itself.
 *
 * A session forked off another keeps a pointer to it, which is only used to draw the sidebar as a tree.
 * pi-durable holds the real lineage: the child's conversation record has the parent and the entry it
 * branched at, and reads its history through that link.
 */

import type { Database } from "bun:sqlite";

export interface SessionRow {
  id: number;
  conversationId: number;
  title: string;
  /** "provider/modelId" chosen for this session; null falls back to the default. */
  model: string | null;
  thinking: string | null;
  createdAt: number;
  updatedAt: number;
  /** The session this one was branched off, or null when it was started from scratch. */
  parentSessionId: number | null;
  /** Entry the branch was taken at: the child inherits the parent's history up to and including it. */
  forkEntryId: number | null;
  /** The machine this session's tools run on (see machines.ts); null runs them on the phone. */
  machineId: number | null;
}

export const DEFAULT_TITLE = "New session";

interface Raw {
  id: number;
  conversation_id: number;
  title: string;
  model: string | null;
  thinking: string | null;
  created_at: number;
  updated_at: number;
  parent_session_id: number | null;
  fork_entry_id: number | null;
  machine_id: number | null;
}

const toRow = (r: Raw): SessionRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  title: r.title,
  model: r.model,
  thinking: r.thinking,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  parentSessionId: r.parent_session_id ?? null,
  forkEntryId: r.fork_entry_id ?? null,
  machineId: r.machine_id ?? null,
});

export class Sessions {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL,
        model TEXT,
        thinking TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Branching and machines arrived after the first release, so older installs need the columns added. SQLite
    // has no ADD COLUMN IF NOT EXISTS, hence the table_info probe.
    for (const column of ["parent_session_id", "fork_entry_id", "machine_id"]) {
      const columns = (db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map(c => c.name);
      if (!columns.includes(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} INTEGER`);
    }
  }

  /** Visible sessions, most recently active first. */
  list(): SessionRow[] {
    return (this.db.query("SELECT * FROM sessions WHERE deleted = 0 ORDER BY updated_at DESC, id DESC").all() as Raw[]).map(toRow);
  }

  get(id: number): SessionRow | undefined {
    const raw = this.db.query("SELECT * FROM sessions WHERE id = ? AND deleted = 0").get(id) as Raw | null;
    return raw ? toRow(raw) : undefined;
  }

  /**
   * The row for a conversation id whether or not it is hidden. A deleted session is only reached
   * this way -- by the purge removing it, and by the branch scan that has to see a hidden parent to
   * know whether a visible branch still reads its history through it.
   */
  byConversation(conversationId: number): (SessionRow & { deleted: boolean }) | undefined {
    const raw = this.db.query("SELECT * FROM sessions WHERE conversation_id = ?").get(conversationId) as Raw | null;
    return raw ? { ...toRow(raw), deleted: raw.deleted === 1 } : undefined;
  }

  create(
    conversationId: number,
    title = DEFAULT_TITLE,
    model: string | null = null,
    thinking: string | null = null,
    parentSessionId: number | null = null,
    forkEntryId: number | null = null,
    machineId: number | null = null,
  ): SessionRow {
    const now = Date.now();
    const result = this.db
      .query(
        `INSERT INTO sessions (conversation_id, title, model, thinking, created_at, updated_at, parent_session_id, fork_entry_id, machine_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, title, model, thinking, now, now, parentSessionId, forkEntryId, machineId);
    return this.get(Number(result.lastInsertRowid))!;
  }

  /**
   * The visible sessions as a forest: every row with its depth, each parent immediately followed by
   * its branches. Groups keep `list()`'s recency order, so the newest branch sits directly under the
   * session it came from. A branch whose parent has been deleted is promoted to a root rather than
   * dropped, so hiding a session never hides conversations that are still switchable.
   */
  tree(): { row: SessionRow; depth: number }[] {
    const rows = this.list();
    const visible = new Set(rows.map(r => r.id));
    const groups = new Map<number, SessionRow[]>();
    for (const row of rows) {
      const parent = row.parentSessionId !== null && visible.has(row.parentSessionId) ? row.parentSessionId : 0;
      const siblings = groups.get(parent) ?? [];
      siblings.push(row);
      groups.set(parent, siblings);
    }
    const out: { row: SessionRow; depth: number }[] = [];
    const walk = (parent: number, depth: number) => {
      for (const row of groups.get(parent) ?? []) {
        out.push({ row, depth });
        walk(row.id, depth + 1);
      }
    };
    walk(0, 0);
    return out;
  }

  rename(id: number, title: string) {
    this.db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title.trim().slice(0, 80) || DEFAULT_TITLE, id);
  }

  setModel(id: number, model: string) {
    this.db.query("UPDATE sessions SET model = ? WHERE id = ?").run(model, id);
  }

  setThinking(id: number, thinking: string) {
    this.db.query("UPDATE sessions SET thinking = ? WHERE id = ?").run(thinking, id);
  }

  /** Change where this session's tools run. A null machine id means the phone. */
  setMachine(id: number, machineId: number | null) {
    this.db.query("UPDATE sessions SET machine_id = ?, updated_at = ? WHERE id = ?").run(machineId, Date.now(), id);
  }

  touch(id: number) {
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /**
   * Drop the row for good. The transcript and the workspace go with it (purge.ts, and the caller),
   * which is why there is nothing here to undo: `deleted` survives only as a column, because
   * installs from before real deletion still carry rows that used it.
   */
  purge(id: number) {
    this.db.transaction(() => {
      // Timings are keyed by session id, so they are the other data this session owns.
      this.db.query("DELETE FROM timings WHERE session = ?").run(id);
      this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    })();
  }
}
