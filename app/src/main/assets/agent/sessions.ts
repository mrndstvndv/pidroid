/**
 * Session registry. pi-durable keeps any number of conversations in one storage but has no notion of titles,
 * recency or deletion, so the app tracks those itself. Deleting a session hides it (and stops its run); the
 * durable transcript stays in storage because pi-durable has no API to remove a conversation.
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
}

const toRow = (r: Raw): SessionRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  title: r.title,
  model: r.model,
  thinking: r.thinking,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
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
  }

  /** Visible sessions, most recently active first. */
  list(): SessionRow[] {
    return (this.db.query("SELECT * FROM sessions WHERE deleted = 0 ORDER BY updated_at DESC, id DESC").all() as Raw[]).map(toRow);
  }

  get(id: number): SessionRow | undefined {
    const raw = this.db.query("SELECT * FROM sessions WHERE id = ? AND deleted = 0").get(id) as Raw | null;
    return raw ? toRow(raw) : undefined;
  }

  create(conversationId: number, title = DEFAULT_TITLE, model: string | null = null, thinking: string | null = null): SessionRow {
    const now = Date.now();
    const result = this.db
      .query("INSERT INTO sessions (conversation_id, title, model, thinking, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conversationId, title, model, thinking, now, now);
    return this.get(Number(result.lastInsertRowid))!;
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

  touch(id: number) {
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  remove(id: number) {
    this.db.query("UPDATE sessions SET deleted = 1 WHERE id = ?").run(id);
  }
}
