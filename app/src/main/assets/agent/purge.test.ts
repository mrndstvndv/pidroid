/**
 * The purge writes SQL against pi-durable's tables directly, which is the one place in the app
 * that deletes rows another component owns. These tests run it against a copy of the real schema
 * (the DDL below is the schema as it exists in pidroid-agent.sqlite, copied verbatim from
 * sqlite_master) with rows shaped like real ones, and check the two things that matter: that a
 * conversation and everything under it is gone, and that nothing else is.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { conversationDescendants, conversationParents, purgeConversations, ROOT_CONVERSATION_ID } from "./purge.ts";

/** The real tables, in the order a purge has to empty them. */
const SCHEMA = `
  CREATE TABLE durable_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_id TEXT NOT NULL, next_seq INTEGER NOT NULL) STRICT;
  CREATE TABLE record_ids (id INTEGER PRIMARY KEY, record_type TEXT NOT NULL CHECK (record_type IN ('conversation','entry','task','submission','document'))) STRICT;
  CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
  CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','running','waiting','completing','terminal')), abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0,1)), background INTEGER NOT NULL CHECK (background IN (0,1)), record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
  CREATE TABLE submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL CHECK (status IN ('queued','placed','done','unanswered')), record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
  CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL CHECK (family IN (0,1)), key_value TEXT NOT NULL, scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session','conversation','task')), owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, record TEXT NOT NULL CHECK (json_valid(record))) STRICT;
  CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('base','delta')), version INTEGER NOT NULL, content TEXT NOT NULL CHECK (json_valid(content)), PRIMARY KEY (document_id, seq)) STRICT;
`;

let db: Database;

/** Count rows in a table, optionally those belonging to one conversation. */
const count = (table: string, conversationId?: number) =>
  conversationId === undefined
    ? (db.query(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c
    : (db.query(`SELECT count(*) c FROM ${table} WHERE conversation_id = ?`).get(conversationId) as { c: number }).c;

/** Conversations are keyed by `id`, not by a `conversation_id` column. */
const conversationCount = (id: number) =>
  (db.query("SELECT count(*) c FROM conversations WHERE id = ?").get(id) as { c: number }).c;

/** A conversation with a transcript, a finished run and the five documents every session gets. */
function seedSession(id: number, parent?: { conversationId: number; at: number }) {
  const record = parent ? JSON.stringify({ id, parent }) : JSON.stringify({ id });
  db.query("INSERT INTO conversations (id, record) VALUES (?, ?)").run(id, record);
  for (let i = 0; i < 3; i++) {
    db.query("INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, ?, ?, ?)").run(id * 100 + i, id, i, "{}");
    db.query("INSERT INTO record_ids (id, record_type) VALUES (?, 'entry')").run(id * 100 + i);
  }
  db.query("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, '\"pi.generation\"', 'terminal', 0, 0, '{}')").run(id * 10, id);
  db.query("INSERT INTO submissions (id, conversation_id, status, record) VALUES (?, ?, 'done', '{}')").run(id * 10, id);
  ["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"].forEach((kind, index) => {
    const docId = id * 1000 + index;
    db.query("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (?, ?, 1, ?, 'conversation', ?, 0, '{}')")
      .run(docId, JSON.stringify(kind), JSON.stringify(kind), id);
    db.query("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, 0, 'base', 1, '{}')")
      .run(docId);
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  db.query("INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '12050', 9000)").run();
  db.query("INSERT INTO conversations (id, record) VALUES (?, '{}')").run(ROOT_CONVERSATION_ID);
  seedSession(100);
  seedSession(200);
});

afterEach(() => db.close());

describe("conversationDescendants", () => {
  test("a plain conversation is its own only descendant", () => {
    expect(conversationDescendants(db, 100)).toEqual([100]);
  });

  test("finds a branch through the record link and a branch of that branch", () => {
    seedSession(300, { conversationId: 100, at: 250 });
    seedSession(400, { conversationId: 300, at: 350 });
    expect(conversationDescendants(db, 100).sort()).toEqual([100, 300, 400]);
    expect(conversationDescendants(db, 300).sort()).toEqual([300, 400]);
  });

  test("finds a branch recorded in owner_conversation_id as well", () => {
    db.query("INSERT INTO conversations (id, owner_conversation_id, record) VALUES (300, 100, '{}')").run();
    expect(conversationDescendants(db, 100).sort()).toEqual([100, 300]);
  });

  test("two conversations each claiming the other as parent does not hang", () => {
    db.query("INSERT INTO conversations (id, record) VALUES (?, ?)").run(300, JSON.stringify({ id: 300, parent: { conversationId: 400, at: 1 } }));
    db.query("INSERT INTO conversations (id, record) VALUES (?, ?)").run(400, JSON.stringify({ id: 400, parent: { conversationId: 300, at: 1 } }));
    expect(conversationDescendants(db, 300).sort()).toEqual([300, 400]);
  });

  test("parents maps both kinds of link, and skips a record with no parent in it", () => {
    seedSession(300, { conversationId: 100, at: 250 });
    db.query("INSERT INTO conversations (id, owner_conversation_id, record) VALUES (400, 200, '{}')").run();
    db.query("INSERT INTO conversations (id, record) VALUES (500, '[1,2,3]')").run();
    const parents = conversationParents(db);
    expect(parents.get(300)).toBe(100);
    expect(parents.get(400)).toBe(200);
    expect(parents.has(500)).toBe(false);
  });

  test("the record column refuses to hold unparseable JSON, so the parse guard is belt and braces", () => {
    expect(() => db.query("INSERT INTO conversations (id, record) VALUES (500, 'not json')").run()).toThrow();
  });
});

describe("purgeConversations", () => {
  test("removes the conversation with its entries, tasks, submissions, documents and revisions", () => {
    const result = purgeConversations(db, [100]);
    expect(result).toEqual({ conversations: 1, entries: 3, tasks: 1, submissions: 1, documents: 5 });
    expect(conversationCount(100)).toBe(0);
    expect(count("entries", 100)).toBe(0);
    expect(count("tasks", 100)).toBe(0);
    expect(count("submissions", 100)).toBe(0);
    expect(count("documents")).toBe(5); // only the other session's five are left
    expect(count("document_revisions")).toBe(5);
  });

  test("leaves every other conversation alone", () => {
    purgeConversations(db, [100]);
    expect(conversationCount(200)).toBe(1);
    expect(count("entries", 200)).toBe(3);
    expect(count("tasks", 200)).toBe(1);
    expect(count("submissions", 200)).toBe(1);
    expect(conversationCount(ROOT_CONVERSATION_ID)).toBe(1);
  });

  test("keeps the id ledger and the sequence metadata: ids must never be handed out twice", () => {
    purgeConversations(db, [100]);
    expect(count("record_ids")).toBe(6); // 3 entries per seeded session; nothing reclaimed
    expect(db.query("SELECT next_id, next_seq FROM durable_metadata").get()).toEqual({ next_id: "12050", next_seq: 9000 });
  });

  test("refuses the root conversation even when asked for it directly", () => {
    const result = purgeConversations(db, [ROOT_CONVERSATION_ID]);
    expect(result.conversations).toBe(0);
    expect(conversationCount(ROOT_CONVERSATION_ID)).toBe(1);
  });

  test("purges a conversation and its branches in one transaction", () => {
    seedSession(300, { conversationId: 100, at: 250 });
    const result = purgeConversations(db, [100, 300]);
    expect(result.conversations).toBe(2);
    expect(count("conversations")).toBe(2); // root + the untouched session 200
    expect(count("entries")).toBe(3);
    expect(count("documents")).toBe(5);
  });

  test("purges a task-scoped document as well as a conversation-scoped one", () => {
    db.query("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (7777, '\"pi.agent\"', 1, '\"pi.agent\"', 'task', 1000, 0, '{}')").run();
    db.query("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (7777, 0, 'base', 1, '{}')").run();
    const result = purgeConversations(db, [100]);
    expect(result.documents).toBe(6);
    expect(count("documents")).toBe(5);
    expect(count("document_revisions")).toBe(5);
  });

  test("leaves a task-scoped document that belongs to somebody else", () => {
    db.query("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (7777, '\"pi.agent\"', 1, '\"pi.agent\"', 'task', 2000, 0, '{}')").run();
    purgeConversations(db, [100]);
    expect(count("documents")).toBe(6);
  });

  test("leaves session-scoped documents, which are root-owned state shared by everything", () => {
    db.query("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (8888, '\"pi.provider\"', 0, '\"pi.provider\"', 'session', 1, 0, '{}')").run();
    purgeConversations(db, [100]);
    expect(count("documents")).toBe(6);
    expect(db.query("SELECT count(*) c FROM documents WHERE id = 8888").get()).toEqual({ c: 1 });
  });

  test("is a no-op for an empty list rather than an error", () => {
    expect(purgeConversations(db, [])).toEqual({ conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 });
    expect(purgeConversations(db, [ROOT_CONVERSATION_ID])).toEqual({ conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 });
  });

  test("deletes nothing when one id is not a conversation, and leaves the rest intact", () => {
    // conversation_id is a plain column with no foreign key, so a stale id reaches the SQL as is.
    const result = purgeConversations(db, [100, 999999]);
    expect(result.conversations).toBe(1);
    expect(conversationCount(200)).toBe(1);
  });

  test("handles more document ids than SQLite allows bound parameters", () => {
    // 1200 documents is well past the 999-parameter limit a single DELETE can bind.
    const insert = db.prepare("INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record) VALUES (?, '\"pi.agent\"', 1, '\"pi.agent\"', 'conversation', 100, 0, '{}')");
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) insert.run(900000 + i);
    })();
    expect(purgeConversations(db, [100]).documents).toBe(1205);
    expect(count("documents")).toBe(5);
  });
});