import { describe, expect, test } from "bun:test";
import { assemble, foldContext, foldedRows } from "./diffrows";

/** A small patch with two hunks, in the shape createTwoFilesPatch emits. */
const PATCH = [
  "Index: a/demo.ts",
  "===================================================================",
  "--- a/demo.ts",
  "+++ b/demo.ts",
  "@@ -1,4 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  " four",
  "@@ -20,3 +20,4 @@ section heading",
  " ctx",
  "+added line",
  " tail",
].join("\n");

describe("assemble", () => {
  test("numbers each side independently", () => {
    const { rows } = assemble(PATCH);
    const body = rows.filter((r) => r.kind !== "meta");
    const show = (n: number | null) => String(n).replace("null", "—");
    expect(body.map((r) => `${r.kind}:${show(r.oldNo)}/${show(r.newNo)}`)).toEqual([
      "ctx:1/1",
      "del:2/—",
      "add:—/2",
      "ctx:3/3",
      "ctx:4/4",
      "ctx:20/20",
      "add:—/21",
      "ctx:21/22",
    ]);
  });

  test("counts additions and removals", () => {
    const { added, removed } = assemble(PATCH);
    expect(added).toBe(2);
    expect(removed).toBe(1);
  });

  test("keeps hunk headers as meta rows with the section heading", () => {
    const { rows } = assemble(PATCH);
    const meta = rows.filter((r) => r.kind === "meta");
    expect(meta).toHaveLength(2);
    expect(meta[1].text).toStartWith("@@ -20,3 +20,4 @@ section heading");
  });

  test("an added file starts the old side at line 1, not 0", () => {
    const { rows } = assemble(["--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"));
    const adds = rows.filter((r) => r.kind === "add");
    expect(adds.map((r) => r.newNo)).toEqual([1, 2]);
    expect(adds.every((r) => r.oldNo === null)).toBe(true);
  });

  test("pulls the right token row for each side", () => {
    const oldRows = ["OLD-1", "OLD-2", "OLD-3"];
    const newRows = ["NEW-1", "NEW-2", "NEW-3"];
    const { rows } = assemble(PATCH, oldRows, newRows);
    const del = rows.find((r) => r.kind === "del")!;
    const add = rows.find((r) => r.kind === "add")!;
    expect(del.html).toBe("OLD-2"); // the removed line is old line 2
    expect(add.html).toBe("NEW-2"); // the added line is new line 2
  });

  test("falls back to null html when a side was not tokenised", () => {
    const { rows } = assemble(PATCH, null, ["NEW-1", "NEW-2"]);
    expect(rows.find((r) => r.kind === "del")!.html).toBeNull();
    expect(rows.find((r) => r.kind === "add")!.html).toBe("NEW-2");
  });

  test("the patch's trailing newline is not a context line", () => {
    const { rows } = assemble("--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n");
    expect(rows.filter((r) => r.kind === "ctx")).toHaveLength(0);
  });

  test("a diff ending in unchanged lines gets no ghost line after them", () => {
    const { rows } = assemble("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 3, text: "c" });
  });

  test("an empty context line is still a line", () => {
    const { rows } = assemble("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n \n-b\n+B\n");
    expect(rows.filter((r) => r.kind === "ctx").map((r) => r.text)).toEqual(["a", ""]);
  });
});

describe("foldContext", () => {
  /** 20 context lines, a change, then 20 more: two long runs, one on each side of the edit. */
  const long = (): ReturnType<typeof assemble>["rows"] => {
    const ctx = Array.from({ length: 20 }, (_, i) => `  line ${i + 1}`);
    return assemble(["--- a/x", "+++ b/x", "@@ -1,41 +1,41 @@", ...ctx, "-old", "+new", ...ctx].join("\n")).rows;
  };
  const placeholdersIn = (rows: ReturnType<typeof assemble>["rows"]) =>
    rows.filter((r) => r.kind === "meta" && r.text.includes("unchanged"));

  test("replaces the middle of each long run with a placeholder", () => {
    const placeholders = placeholdersIn(foldContext(long(), 3, 6));
    expect(placeholders).toHaveLength(2); // one before the edit, one after
    expect(placeholders[0].text).toBe("14 unchanged lines"); // 20 - 3 - 3
  });

  test("the placeholder stands in for exactly the hidden rows", () => {
    const rows = long();
    const folded = foldContext(rows, 3, 6);
    const hidden = foldedRows(placeholdersIn(folded)[0]);
    expect(hidden).toHaveLength(14);
    expect(hidden[0].text).toBe(" line 4"); // the marker space is consumed, leaving one
  });

  test("folding hides rows but never drops them", () => {
    const rows = long();
    const folded = foldContext(rows, 3, 6);
    // Expanding every placeholder must reproduce the original rows exactly, in order. This is the
    // invariant that matters: the viewer's expand button splices these back in.
    const expanded = folded.flatMap((r) => {
      const hidden = foldedRows(r);
      return hidden.length ? hidden : [r];
    });
    expect(expanded).toEqual(rows);
  });

  test("short runs are left alone", () => {
    const rows = assemble(PATCH).rows;
    expect(foldContext(rows, 3, 6)).toHaveLength(rows.length);
  });

  test("does not mutate its input", () => {
    const rows = long();
    const before = rows.length;
    foldContext(rows, 3, 6);
    expect(rows).toHaveLength(before);
  });
});