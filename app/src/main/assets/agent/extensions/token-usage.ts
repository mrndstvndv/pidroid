/**
 * Persist provider-reported usage for every completed model response. A single user turn may
 * involve several model responses (for example, before and after tool calls), so each response
 * gets its own row and the Stats API rolls them up by session and time period.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

const APP_DIR = process.cwd();
const DB_PATH = join(APP_DIR, "pidroid.sqlite");
const SNAPSHOT_PATH = join(APP_DIR, ".tmp", "token-usage-stats.json");

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      event_key TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_total REAL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS token_usage_by_session_time
      ON token_usage_events (session_id, captured_at);
    CREATE INDEX IF NOT EXISTS token_usage_by_time
      ON token_usage_events (captured_at);
  `);
}

/** Keep a read-only snapshot for the UI while the app is running its safe-mode server. */
function writeSnapshot(db: Database): void {
  let sessions: any[] = [];
  let sessionsTableAvailable = false;
  try {
    sessions = db.query("SELECT id, title, created_at AS createdAt FROM sessions WHERE deleted = 0 ORDER BY id").all() as any[];
    sessionsTableAvailable = true;
  } catch {
    // The normal server installs extensions before creating its sessions table; records are still usable by ID.
  }
  const allRecords = db.query(`
    SELECT session_id AS sessionId, conversation_id AS conversationId, captured_at AS capturedAt,
           provider, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
           total_tokens AS tokens, cost_total AS cost
    FROM token_usage_events
    ORDER BY captured_at ASC
  `).all() as any[];
  const activeIds = new Set(sessions.map((row) => Number(row.id)));
  const records = sessionsTableAvailable ? allRecords.filter((row) => activeIds.has(Number(row.sessionId))) : allRecords;
  const payload = JSON.stringify({ generatedAt: Date.now(), sessions, records });
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  const temp = `${SNAPSHOT_PATH}.tmp`;
  writeFileSync(temp, payload);
  renameSync(temp, SNAPSHOT_PATH);
}

function initializeUsageStore(): void {
  try {
    const db = new Database(DB_PATH, { readwrite: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      ensureSchema(db);
      writeSnapshot(db);
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn(`[pidroid] token usage store init: ${error instanceof Error ? error.message : String(error)}`);
  }
}

initializeUsageStore();

type UsageValue = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function stableKey(conversationId: number, taskId: unknown, message: any, usage: UsageValue): string {
  // Task IDs are stable across a durable retry. Hash the response shape as well, so separate
  // provider attempts within a task remain distinct while a replay of the same response is
  // idempotent. No prompt or response text is stored in the ledger.
  const content = Array.isArray(message?.content)
    ? message.content.map((block: any) => ({
        type: block?.type,
        text: block?.text,
        thinking: block?.thinking,
        id: block?.id,
        name: block?.name,
        arguments: block?.arguments,
      }))
    : [];
  const keyData = JSON.stringify({
    taskId: String(taskId),
    provider: String(message?.provider ?? ""),
    model: String(message?.model ?? ""),
    stopReason: String(message?.stopReason ?? ""),
    content,
    usage: {
      input: count(usage.input),
      output: count(usage.output),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
      totalTokens: count(usage.totalTokens),
      cost: typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : null,
    },
  });
  const digest = new Bun.CryptoHasher("sha256").update(keyData).digest("hex");
  return `${conversationId}:${String(taskId)}:${digest}`;
}

function recordUsage(conversationId: number, taskId: unknown, message: any): void {
  const usage = (message?.usage ?? {}) as UsageValue;
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const tokens = input + output + cacheRead + cacheWrite;
  const cost = typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : null;
  if (!tokens && cost === null) return;

  const db = new Database(DB_PATH, { readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    ensureSchema(db);
    const session = db
      .query("SELECT id FROM sessions WHERE conversation_id = ? AND deleted = 0")
      .get(conversationId) as { id: number } | null;
    // Ignore internal/owned conversations that are not one of the app's visible sessions.
    if (!session) return;

    db.query(`
      INSERT OR IGNORE INTO token_usage_events (
        event_key, session_id, conversation_id, task_id, captured_at,
        provider, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, cost_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stableKey(conversationId, taskId, message, usage),
      session.id,
      conversationId,
      String(taskId),
      Date.now(),
      String(message?.provider ?? "unknown"),
      String(message?.model ?? "unknown"),
      input,
      output,
      cacheRead,
      cacheWrite,
      tokens,
      cost,
    );
    writeSnapshot(db);
  } finally {
    db.close();
  }
}

export default defineExtension({
  name: "token-usage",
  hooks: [
    hook(GenerationTask, {
      afterResponse: (message, api) => {
        try {
          recordUsage(Number(api.conversationId), api.taskId, message);
        } catch (error) {
          // Usage logging is observational: a stats-database problem must never fail a model turn.
          console.warn(`[pidroid] token usage recorder: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
  ],
});
