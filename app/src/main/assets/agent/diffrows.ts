/**
 * Turning a unified patch into rows a diff viewer can paint.
 *
 * This is deliberately a pure function with no I/O and no knowledge of highlighting: it maps patch
 * lines to line numbers on each side of the diff, and looks up the caller's pre-tokenised HTML for
 * that line. The caller supplies `oldRows` / `newRows` (from highlight.ts, one entry per source
 * line, index 0 = line 1); when it cannot tokenise -- unknown language, file too big, binary --
 * it passes nothing and every row falls back to escaped plain text.
 *
 * Doing it this way means the diff view gets *real* syntax colours on both sides rather than
 * Shiki's generic `diff` grammar, and it means this logic is testable without a highlighter.
 */

/** One rendered line of a diff. */
export interface DiffRow {
  /** "add" (only in the new file), "del" (only in the old), "ctx" (in both), or "meta". */
  kind: "add" | "del" | "ctx" | "meta";
  /** 1-based line number on the old side, or null where the line does not exist there. */
  oldNo: number | null;
  /** 1-based line number on the new side, or null where the line does not exist there. */
  newNo: number | null;
  /** Already-escaped HTML for the line's content, or null when there is nothing to show. */
  html: string | null;
  /** Plain text, for copy and for the fold placeholders. */
  text: string;
}

export interface DiffSummary {
  rows: DiffRow[];
  added: number;
  removed: number;
}

/** Escape, matching what the client does for unhighlighted text. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `@@ -12,7 +13,9 @@ optional section heading` -> the two starting line numbers. */
function parseHunk(header: string): { oldStart: number; newStart: number } | null {
  const m = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[3]) };
}

/**
 * Build the rows for a patch.
 *
 * Hunk headers reset the line counters, which is the whole trick: within a hunk every context line
 * advances both sides, a `-` advances only the old, and a `+` only the new. A `-0,0` start (a pure
 * addition) means the old side's first real line is 1, not 0.
 */
export function assemble(patch: string, oldRows?: string[] | null, newRows?: string[] | null): DiffSummary {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  const tokenFor = (side: string[] | null | undefined, line: number): string | null => {
    if (!side) return null;
    const hit = side[line - 1];
    return typeof hit === "string" ? hit : null;
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("Index: ") || raw.startsWith("diff --git")) {
      continue; // file header lines: the path is already the heading above the diff
    }
    if (raw.startsWith("@@")) {
      const hunk = parseHunk(raw);
      // An empty old-side range (@@ -0,0) means "added at the top"; keep the next old line at 1.
      oldNo = hunk ? (hunk.oldStart === 0 ? 1 : hunk.oldStart) : 0;
      newNo = hunk ? (hunk.newStart === 0 ? 1 : hunk.newStart) : 0;
      inHunk = true;
      rows.push({ kind: "meta", oldNo: null, newNo: null, html: null, text: raw });
      continue;
    }
    if (!inHunk) continue;

    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === "+") {
      rows.push({ kind: "add", oldNo: null, newNo: newNo, html: tokenFor(newRows, newNo), text: body });
      added++;
      newNo++;
    } else if (marker === "-") {
      rows.push({ kind: "del", oldNo, newNo: null, html: tokenFor(oldRows, oldNo), text: body });
      removed++;
      oldNo++;
    } else if (marker === " " || raw === "") {
      // A trailing empty string is the patch's final newline, not a real context line.
      if (raw === "" && newNo > 0 && oldNo > 0 && rows.length && rows[rows.length - 1].kind !== "ctx") continue;
      rows.push({ kind: "ctx", oldNo, newNo, html: tokenFor(newRows, newNo) ?? tokenFor(oldRows, oldNo), text: body });
      oldNo++;
      newNo++;
    } else if (marker === "\\") {
      rows.push({ kind: "meta", oldNo: null, newNo: null, html: null, text: raw }); // "\ No newline at end of file"
    }
    // Anything else inside a hunk is not a diff line; ignore it rather than invent a row.
  }

  return { rows, added, removed };
}

/**
 * Collapse runs of unchanged lines, keeping `keep` at each end, and replace the middle with one
 * placeholder row the viewer can tap to expand again. Returns a new array; the input is untouched so
 * the same patch can be re-rendered at a different context size.
 *
 * Only runs longer than `keep * 2 + minFold` are worth folding, otherwise folding a short gap costs
 * a tap and hides nothing.
 */
export function foldContext(rows: DiffRow[], keep = 3, minFold = 6): DiffRow[] {
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "ctx") {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "ctx") j++;
    const run = j - i;
    if (run <= keep * 2 + minFold) {
      for (let k = i; k < j; k++) out.push(rows[k]);
    } else {
      for (let k = i; k < i + keep; k++) out.push(rows[k]);
      out.push({
        kind: "meta",
        oldNo: rows[i + keep].oldNo,
        newNo: rows[i + keep].newNo,
        html: null,
        text: `${run - keep * 2} unchanged lines`,
        // A placeholder carries the lines it stands in for, so expanding is exact rather than a
        // second request: the viewer splices them back in.
        ...({ folded: rows.slice(i + keep, j - keep) } as object),
      });
      for (let k = j - keep; k < j; k++) out.push(rows[k]);
    }
    i = j;
  }
  return out;
}

/** Rows a placeholder stands in for, if it is one. */
export function foldedRows(row: DiffRow): DiffRow[] {
  return (row as DiffRow & { folded?: DiffRow[] }).folded ?? [];
}

/** Copy-ready text: the patch without the hunk bookkeeping would be wrong, so keep the markers. */
export function asText(rows: DiffRow[]): string {
  return rows.map((r) => (r.kind === "meta" ? r.text : `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`)).join("\n");
}

/** Plain (unhighlighted) HTML for one row, used when the server could not tokenise either side. */
export function plainHtml(row: DiffRow): string {
  return esc(row.text);
}