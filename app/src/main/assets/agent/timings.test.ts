import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { blockStartKey, messageEndKey, RUN_KEY, Timings, toolEndKey } from "./timings.ts";

function makeDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE timings (session INTEGER NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session, key)) WITHOUT ROWID");
  return db;
}

describe("Timings incremental stamping", () => {
  test("keeps live block starts stable and stamps only newly committed entries", () => {
    const db = makeDb();
    const timings = new Timings(db, 1);
    const user = { id: 1, kind: "pi.user", model: [{ content: "run it" }] };
    const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } };

    timings.stamp({
      entries: [user],
      docs: { "pi.live": { run: true, generation: { message: { content: [call] } } } },
    }, 1_000);
    expect(timings.lookup(RUN_KEY)).toBe(1_000);
    expect(timings.liveStarts()).toEqual([1_000]);

    // A repeated snapshot with no committed suffix must not move the run or block start.
    timings.stamp({
      entries: [user],
      docs: { "pi.live": { run: true, generation: { message: { content: [call] } } } },
    }, 2_000);
    expect(timings.lookup(RUN_KEY)).toBe(1_000);
    expect(timings.liveStarts()).toEqual([1_000]);

    const assistant = {
      id: 2,
      kind: "pi.assistant",
      model: [{ content: [call] }],
    };
    timings.stamp({ entries: [user, assistant], docs: {} }, 3_000);
    expect(timings.lookup(blockStartKey(2, 0))).toBe(1_000);
    expect(timings.lookup(messageEndKey(2))).toBe(3_000);
    expect(timings.lookup(RUN_KEY)).toBeUndefined();
    expect(timings.liveStarts()).toBeUndefined();

    const result = {
      id: 3,
      kind: "pi.tool-result",
      model: [{ toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }],
    };
    timings.stamp({ entries: [user, assistant, result], docs: {} }, 4_000);
    expect(timings.lookup(toolEndKey("call-1"))).toBe(4_000);

    timings.close();
    db.close();
  });

  test("reconciles timing keys if a view is replaced with a different log prefix", () => {
    const db = makeDb();
    const timings = new Timings(db, 2);
    const user = { id: 1, kind: "pi.user", model: [{ content: "old" }] };
    timings.stamp({
      entries: [user],
      docs: { "pi.live": { run: true, generation: { message: { content: [{ type: "text", text: "old" }] } } } },
    }, 100);
    const oldAssistant = { id: 2, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "old" }] }] };
    timings.stamp({ entries: [user, oldAssistant], docs: {} }, 150);
    timings.flush();
    expect(timings.lookup(blockStartKey(2, 0))).toBe(100);

    const replacement = { id: 9, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "new" }] }] };
    timings.stamp({ entries: [replacement], docs: {} }, 200);
    timings.close();

    const keys = db.query("SELECT key FROM timings WHERE session = 2 ORDER BY key").all() as { key: string }[];
    expect(keys.map((row) => row.key)).toEqual([messageEndKey(9)]);
    db.close();
  });
});
