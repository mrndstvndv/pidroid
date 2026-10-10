import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Sessions } from "./sessions.ts";

let db: Database;
let sessions: Sessions;

beforeEach(() => {
  db = new Database(":memory:");
  sessions = new Sessions(db);
});

afterEach(() => db.close());

describe("Sessions.setMachine", () => {
  test("moves a phone session to a machine and back", () => {
    const row = sessions.create(71);

    sessions.setMachine(row.id, 4);
    expect(sessions.get(row.id)?.machineId).toBe(4);

    sessions.setMachine(row.id, null);
    expect(sessions.get(row.id)?.machineId).toBeNull();
  });
});
