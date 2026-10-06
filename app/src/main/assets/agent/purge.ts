/**
 * Removing a session for real.
 *
 * pi-durable's storage is append-only by design and exposes no delete: its members are commit,
 * mintId, conversation, scanConversations, entry, scanEntries, readEntry, task, scanTasks,
 * submission, document, close -- nothing that removes a row. So "delete session" used to mean
 * `UPDATE sessions SET deleted = 1` in the app's own table, which hid the session and left
 * everything it had written in place forever: the transcript in pidroid-agent.sqlite and the
 * workspace directory under files/workspaces/.
 *
 * This module is the other half. It writes the deletes itself, over the same file the harness has
 * open, so both halves of a session can actually go away.
 *
 * Two things it deliberately leaves alone:
 *
 * - `record_ids` and `durable_metadata`. Those are the global id ledger: every entry, task,
 *   submission and document id ever minted is recorded so the allocator can prove an id was never
 *   handed out twice. Deleting a row from `record_ids` would let a later conversation be given the
 *   id of an entry some other conversation still holds. Reclaiming ids is not worth the space.
 * - The root conversation (id 1). It predates sessions, every conversation is reachable from it,
 *   and no session row points at it.
 *
 * Forks are the reason deletion cannot simply cascade. A branch's conversation record carries
 * `{"id":N,"parent":{"conversationId":P,"at":E}}` and its transcript is the parent's entries up to E
 * plus its own after that -- pi-durable reads them through that link and never duplicates them. The
 * parent's entries *are* part of the branch's history, so purging a parent would silently amputate
 * a branch that is still in the sidebar. `conversationDescendants()` finds that subtree so the
 * caller can refuse, or purge the already-deleted part of it.
 */

import type { Database } from "bun:sqlite";

/** pi-durable's root conversation. Never deleted: everything hangs off it. */
export const ROOT_CONVERSATION_ID = 1;

export interface PurgeResult {
  conversations: number;
  entries: number;
  tasks: number;
  submissions: number;
  documents: number;
}

interface ConversationRow {
  id: number;
  owner_conversation_id: number | null;
  record: string;
}

/**
 * Which conversation each conversation was forked from, as `child -> parent`.
 *
 * Two places record it and both are read: the `parent.conversationId` inside the record is what
 * `fork(at, { ownership: { kind: "ownerless" } })` writes -- the mode this app branches with -- and
 * `owner_conversation_id` is the column pi-durable uses when a conversation is owned by another.
 * Reading only one of them would miss half the forks depending on which mode created them.
 */
export function conversationParents(db: Database): Map<number, number> {
  const parents = new Map<number, number>();
  for (const row of db.query("SELECT id, owner_conversation_id, record FROM conversations").all() as ConversationRow[]) {
    if (row.owner_conversation_id !== null) {
      parents.set(row.id, row.owner_conversation_id);
      continue;
    }
    try {
      const parent = JSON.parse(row.record)?.parent?.conversationId;
      if (typeof parent === "number") parents.set(row.id, parent);
    } catch {
      // A record that will not parse has no readable link. Better to miss a dependency here and
      // let the caller see an ordinary conversation than to refuse every delete on a bad row.
    }
  }
  return parents;
}

/**
 * `conversationId` followed by every conversation forked from it, directly or through a chain of
 * forks. A branch of a branch is included: its history reaches back through the whole chain.
 */
export function conversationDescendants(db: Database, conversationId: number): number[] {
  const parents = conversationParents(db);
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const out = [conversationId];
  const seen = new Set(out);
  // Breadth-first rather than recursive: the chain is short, but a cycle in the records (two
  // conversations each claiming the other as parent) must not hang the delete.
  for (let i = 0; i < out.length; i++) {
    for (const child of children.get(out[i]) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
    }
  }
  return out;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Delete every row pi-durable stored for these conversations, in one transaction.
 *
 * The order follows what points at what: revisions before their document, documents before the
 * conversation, and the conversation last. Nothing here declares a foreign key -- SQLite would not
 * stop a half-finished purge -- so the order is the whole guarantee, and the transaction is what
 * makes it all-or-nothing if a statement fails half way.
 */
export function purgeConversations(db: Database, ids: number[]): PurgeResult {
  const wanted = [...new Set(ids)].filter(id => id !== ROOT_CONVERSATION_ID);
  const empty: PurgeResult = { conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 };
  if (!wanted.length) return empty;

  const run = db.transaction((conversationIds: number[]) => {
    const marks = placeholders(conversationIds.length);
    const count = (sql: string, ...args: unknown[]) =>
      (db.query(sql).get(...(args as never[])) as { c: number }).c;

    const taskIds = (
      db.query(`SELECT id FROM tasks WHERE conversation_id IN (${marks})`).all(...(conversationIds as never[])) as { id: number }[]
    ).map(r => r.id);

    // A document is owned either by the conversation itself (scope 'conversation': the agent doc,
    // the inbox, the live partial, usage) or by one of its tasks (scope 'task'). Scope 'session'
    // is deliberately not matched: that is root-owned state shared by everything.
    const docIds = new Set<number>();
    for (const row of db
      .query(`SELECT id FROM documents WHERE scope_kind = 'conversation' AND owner_id IN (${marks})`)
      .all(...(conversationIds as never[])) as { id: number }[]) {
      docIds.add(row.id);
    }
    if (taskIds.length) {
      const taskMarks = placeholders(taskIds.length);
      for (const row of db
        .query(`SELECT id FROM documents WHERE scope_kind = 'task' AND owner_id IN (${taskMarks})`)
        .all(...(taskIds as never[])) as { id: number }[]) {
        docIds.add(row.id);
      }
    }

    const submissions = count(`SELECT count(*) c FROM submissions WHERE conversation_id IN (${marks})`, ...conversationIds);
    const tasks = count(`SELECT count(*) c FROM tasks WHERE conversation_id IN (${marks})`, ...conversationIds);
    const entries = count(`SELECT count(*) c FROM entries WHERE conversation_id IN (${marks})`, ...conversationIds);
    const conversations = count(`SELECT count(*) c FROM conversations WHERE id IN (${marks})`, ...conversationIds);

    db.query(`DELETE FROM submissions WHERE conversation_id IN (${marks})`).run(...(conversationIds as never[]));
    db.query(`DELETE FROM tasks WHERE conversation_id IN (${marks})`).run(...(conversationIds as never[]));
    db.query(`DELETE FROM entries WHERE conversation_id IN (${marks})`).run(...(conversationIds as never[]));
    if (docIds.size) {
      const docs = [...docIds];
      // Chunked: SQLite caps a statement at 999 bound parameters, and a long-lived conversation
      // can own more documents than that once one is added per tool call.
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const chunkMarks = placeholders(chunk.length);
        db.query(`DELETE FROM document_revisions WHERE document_id IN (${chunkMarks})`).run(...(chunk as never[]));
        db.query(`DELETE FROM documents WHERE id IN (${chunkMarks})`).run(...(chunk as never[]));
      }
    }
    db.query(`DELETE FROM conversations WHERE id IN (${marks})`).run(...(conversationIds as never[]));

    return { conversations, entries, tasks, submissions, documents: docIds.size };
  });

  return run(wanted);
}