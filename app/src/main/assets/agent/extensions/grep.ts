/**
 * grep: search file contents, in-process, without shelling out.
 *
 * Why this exists: /system/bin/grep on Android is toybox grep, not GNU grep. It handles the
 * common cases (-r, -n, -i, -E, -w, -o, -A/-B/-C, --include, --exclude-dir, -l, -c, -q) but
 * hard-fails with "Unknown option" and exit 2 on the GNU-only flags an agent reaches for by
 * habit: -P (perl regex), --stats, --group-separator. It also cannot skip binaries, so a
 * recursive grep over a source tree walks .git objects and the sqlite write-ahead log and
 * drowns the real matches in "Binary file ... matches". Shelling out additionally drags in this
 * sandbox's broken getcwd, which prefixes stderr to every single command.
 *
 * So: walk the tree in JS and match line by line. That makes -P-style perl syntax work for
 * real, gives binary/.git/sqlite skipping by default, caps output so a runaway pattern cannot
 * flood the context window, and never spawns a process -- which matters on Android, where
 * spawning too many children gets the whole app killed.
 *
 * After editing, call reload_extensions. No restart needed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

/** Directories never descended into: version-control internals and installed deps. */
const SKIP_DIRS = new Set([".git", "node_modules", ".bun"]);

/** Never worth reading: session databases and their write-ahead logs are large and binary. */
const SKIP_SUFFIXES = [".sqlite", ".sqlite-wal", ".sqlite-shm"];

/** Past this, a "text" file is a bundle or an archive, not source. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Enough for a source search; past this the context window is the thing that breaks. */
const MAX_MATCHES = 200;

/** Bounds the walk itself, so a huge tree cannot hang the app. */
const MAX_FILES = 5000;

type Mode = "content" | "files" | "count";

/** One output line. `kind` distinguishes real matches from context, so rendering can tell them apart. */
interface Line {
  file: string;
  line: number;
  text: string;
  kind: "match" | "context";
}

export interface GrepOptions {
  pattern: string;
  paths: string[];
  ignoreCase?: boolean;
  fixedString?: boolean;
  wholeWord?: boolean;
  mode?: Mode;
  context?: number;
  include?: string[];
  exclude?: string[];
  maxMatches?: number;
  maxFiles?: number;
  /**
   * Display root only: match paths are printed relative to it when they sit
   * under it, and absolute otherwise. Defaults to the caller's cwd via the tool.
   * It has no say in *resolution* -- see resolvePath below.
   */
  base?: string;

  /**
   * Turns a caller-supplied path into an absolute one. Required only for relative
   * paths, and deliberately injected rather than looked up here: the tool passes
   * ExecutionEnv.absolutePath, which resolves against the same cwd bash starts in,
   * so `grep`, `read`, `write`, `edit` and `bash` all agree on what "." means. This
   * file used to anchor on its own location (the parent of extensions/, i.e. the app
   * dir), which made the same relative path mean two different things depending on
   * which tool ran it. Absolute paths work without a resolver.
   */
  resolvePath?: (path: string) => Promise<string>;
}

export interface GrepResult {
  lines: Line[];
  /** file -> number of matching lines, for the files/count modes and the summary. */
  counts: Map<string, number>;
  filesScanned: number;
  truncated: boolean;
  notes: string[];
}

/** Glob -> RegExp. Supports *, ?, **, {a,b}; a leading ! is handled by the caller. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/foo` must also match a bare `foo`
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A bare "*.ts" is meant as "**\/*.ts", which is what every caller means by it. */
function compileGlob(glob: string): RegExp {
  return globToRegExp(glob.includes("/") ? glob : `**/${glob}`);
}

function matchesGlobs(rel: string, include: RegExp[], exclude: RegExp[]): boolean {
  if (exclude.some((re) => re.test(rel))) return false;
  return include.length === 0 || include.some((re) => re.test(rel));
}

/** A NUL byte in the first block is the same heuristic file(1) uses to call a file binary. */
function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The whole search, as a plain function so it can be exercised without the tool wrapper.
 * Throws only for a malformed pattern; unreadable files are collected in `notes`.
 */
export async function runGrep(opts: GrepOptions): Promise<GrepResult> {
  const resolvePath = opts.resolvePath;
  /** Paths under the base print relative; anything else stays absolute, since a ../../.. chain reads worse than the real path. */
  const display = (target: string): string => {
    const rel = opts.base ? relative(opts.base, target) : target;
    const shown = rel && !rel.startsWith("..") ? rel : target;
    return shown.replace(/\\/g, "/");
  };
  const mode: Mode = opts.mode ?? "content";
  const context = Math.max(0, opts.context ?? 0);
  const maxMatches = Math.max(1, opts.maxMatches ?? MAX_MATCHES);
  const maxFiles = Math.max(1, opts.maxFiles ?? MAX_FILES);
  const notes: string[] = [];

  const include = (opts.include ?? []).map((g) => compileGlob(g));
  const exclude = (opts.exclude ?? []).map((g) => compileGlob(g));

  // Compile once, up front: a bad pattern should be a clear error, not a silent empty result.
  let body = opts.fixedString ? escapeRe(opts.pattern) : opts.pattern;
  if (opts.wholeWord) body = `\\b(?:${body})\\b`;
  let re: RegExp;
  try {
    re = new RegExp(body, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new Error(
      `Invalid regular expression ${JSON.stringify(opts.pattern)}: ${err instanceof Error ? err.message : String(err)}. ` +
        `This tool takes JavaScript regex syntax, which covers perl-style -P patterns. ` +
        `Set fixed_string=true to search for the pattern literally.`,
    );
  }

  // Collect the files worth reading first, so the match budget is spent on real content.
  const candidates: string[] = [];
  async function walk(target: string): Promise<void> {
    if (candidates.length >= maxFiles) return;
    let st;
    try {
      st = await lstat(target);
    } catch {
      notes.push(`No such file or directory: ${target}`);
      return;
    }
    if (st.isSymbolicLink()) return; // a symlinked dir can cycle, and adds nothing we do not have
    if (st.isFile()) {
      const rel = display(target);
      if (SKIP_SUFFIXES.some((s) => rel.endsWith(s))) return;
      if (st.size > MAX_FILE_BYTES) {
        notes.push(`Skipped (over ${MAX_FILE_BYTES} bytes): ${rel}`);
        return;
      }
      if (matchesGlobs(rel, include, exclude)) candidates.push(target);
      return;
    }
    if (!st.isDirectory()) return;

    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      notes.push(`Cannot read directory ${target} (permissions, or it moved).`);
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(target, entry.name));
      } else if (entry.isFile()) {
        await walk(join(target, entry.name));
      }
    }
  }

  for (const raw of opts.paths.length ? opts.paths : ["."]) {
    if (!isAbsolute(raw) && !resolvePath) {
      throw new Error(
        `cannot resolve ${JSON.stringify(raw)} without a base directory: pass an absolute path, or a resolvePath resolver`,
      );
    }
    await walk(isAbsolute(raw) ? raw : await resolvePath!(raw));
  }

  const lines: Line[] = [];
  const counts = new Map<string, number>();
  let filesScanned = 0;
  let truncated = false;
  let binariesSkipped = 0;

  for (const file of candidates) {
    if (lines.length >= maxMatches) {
      truncated = true;
      break;
    }
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(await readFile(file));
    } catch {
      notes.push(`Cannot read ${file}.`);
      continue;
    }
    if (looksBinary(buf)) {
      binariesSkipped++;
      continue;
    }
    filesScanned++;

    const rel = display(file);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const fileLines = text.split("\n");

    // Where this file's matches land, so context can be pulled around them afterwards.
    const hitLineNumbers: number[] = [];
    for (let i = 0; i < fileLines.length; i++) {
      if (re.test(fileLines[i])) hitLineNumbers.push(i);
    }
    if (hitLineNumbers.length === 0) continue;

    counts.set(rel, hitLineNumbers.length);
    if (mode !== "content") continue;

    // Expand each hit to [line-before, line+after], keeping separators where the runs do not join.
    const wanted = new Map<number, "match" | "context">();
    for (const hit of hitLineNumbers) {
      if (!wanted.has(hit)) wanted.set(hit, "match");
      for (let c = hit - context; c <= hit + context; c++) {
        if (c >= 0 && c < fileLines.length && !wanted.has(c)) wanted.set(c, "context");
      }
    }

    let emitted = 0;
    for (let n = 0; n < fileLines.length; n++) {
      const kind = wanted.get(n);
      if (!kind) continue;
      if (lines.length >= maxMatches) {
        truncated = true;
        break;
      }
      // Trim the \r of a CRLF file so the printed text matches what is in the file.
      lines.push({ file: rel, line: n + 1, text: fileLines[n].replace(/\r$/, ""), kind });
      emitted++;
    }
    if (emitted === 0 && wanted.size > 0) truncated = true;
  }

  if (binariesSkipped > 0) notes.push(`${binariesSkipped} binary file(s) skipped.`);
  return { lines, counts, filesScanned, truncated, notes };
}

const grep = defineTool({
  name: "grep",
  // The chat view reads this (see extensions.ts): the summary line wants the pattern, but the
  // generic guess would pick `path` first and label every call with the directory searched.
  view: { summaryArg: "pattern" },
  description:
    "Search file contents by regular expression and return matching lines prefixed file:line, the way " +
    "grep does. Prefer this over running grep through bash: the grep on this device is toybox grep, " +
    "which rejects the GNU flags an agent reaches for by habit (-P, --stats and --group-separator all " +
    "fail with 'Unknown option'), cannot skip binaries, and picks up a broken getcwd on every command. " +
    "This runs in-process, so the pattern is a full JavaScript regex and perl-style constructs such as " +
    '"\\d", "\\w" and lookbehind all work as if -P had been passed. Skips .git, node_modules, sqlite and ' +
    "binary files by default, and caps its output so one broad pattern cannot flood the context window.",
  parameters: Type.Object({
    pattern: Type.String({
      description:
        'Regular expression to search for, or literal text when fixed_string=true. e.g. "defineTool", "TODO|FIXME", "(?<=export )\\w+".',
    }),
    path: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "File or directory to search, or an array of them. Relative paths resolve against your cwd, the same as bash, " +
          "read/write/edit — so the default '.' is this session's workspace. Pass $PIDROID_APP_DIR (or any absolute path) " +
          "to search the app tree.",
      }),
    ),
    ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive match (grep -i). Default false." })),
    fixed_string: Type.Optional(Type.Boolean({ description: "Treat the pattern as literal text (grep -F). Default false." })),
    whole_word: Type.Optional(Type.Boolean({ description: "Match only whole words (grep -w). Default false." })),
    mode: Type.Optional(
      Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], {
        description:
          "'content' = matching lines with file:line prefixes (default), 'files' = only the file names (grep -l), 'count' = match count per file (grep -c).",
      }),
    ),
    context: Type.Optional(Type.Number({ description: "Lines of context to show around each match (grep -C). Default 0." })),
    include: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Only search files matching these globs, e.g. '*.ts'. Pass an array for several, or prefix an entry with ! to exclude it instead.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "Skip files matching these globs, e.g. '*.min.js'. Applied after include.",
      }),
    ),
    max_matches: Type.Optional(Type.Number({ description: `Stop after this many output lines (default ${MAX_MATCHES}).` })),
    max_files: Type.Optional(Type.Number({ description: `Walk at most this many files (default ${MAX_FILES}).` })),
  }),
  execute: async (args, api, context) => {
    const toList = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
    const rawPath = args.path ?? ".";
    const paths = Array.isArray(rawPath) ? rawPath.map(String) : [String(rawPath)];
    const mode = (args.mode ?? "content") as Mode;

    let res: GrepResult;
    try {
      res = await runGrep({
        pattern: String(args.pattern),
        paths,
        base: api.env?.cwd,
        resolvePath: api.env
          ? async (p: string) => {
              // The same resolution read/write/edit use: ExecutionEnv.absolutePath, so this tool
              // follows the conversation's cwd instead of guessing one from the module URL.
              const resolved = await api.env!.absolutePath(p, context);
              if (!resolved.ok) throw new Error(resolved.error?.message ?? `cannot resolve ${JSON.stringify(p)}`);
              return resolved.value;
            }
          : undefined,
        ignoreCase: args.ignore_case === true,
        fixedString: args.fixed_string === true,
        wholeWord: args.whole_word === true,
        mode,
        context: Number(args.context ?? 0),
        include: toList(args.include),
        exclude: toList(args.exclude),
        maxMatches: Number(args.max_matches ?? MAX_MATCHES),
        maxFiles: Number(args.max_files ?? MAX_FILES),
      });
    } catch (err) {
      api.output(`grep: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }

    const total = [...res.counts.values()].reduce((a, b) => a + b, 0);
    const where = paths.join(", ");
    const out: string[] = [];

    if (total === 0) {
      out.push(`No matches for ${JSON.stringify(args.pattern)} in ${where} (${res.filesScanned} file(s) searched).`);
    } else if (mode === "files") {
      out.push(`${res.counts.size} file(s) matching ${JSON.stringify(args.pattern)}:`);
      out.push(...[...res.counts.keys()].sort());
    } else if (mode === "count") {
      out.push(`Match counts for ${JSON.stringify(args.pattern)}:`);
      out.push(...[...res.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f, c]) => `${f}:${c}`));
    } else {
      // Group by file and mark context runs, so several matches in one file stay readable.
      let currentFile = "";
      let previousLine = -1;
      for (const l of res.lines) {
        if (l.file !== currentFile) {
          currentFile = l.file;
          previousLine = -1;
        } else if (l.line > previousLine + 1) {
          out.push("--");
        }
        out.push(`${l.file}:${l.line}:${l.kind === "context" ? "-" : ""}${l.text}`);
        previousLine = l.line;
      }
    }

    if (res.truncated) {
      out.push(`[truncated at max_matches; ${total} match(es) total. Narrow the pattern, add include=, or raise max_matches.]`);
    }
    out.push(`[${total} match(es) in ${res.counts.size} file(s); ${res.filesScanned} file(s) scanned]`);
    for (const note of res.notes.slice(0, 5)) out.push(`[${note}]`);

    api.output(out.join("\n"));
    return {};
  },
});

export default defineExtension({
  name: "grep",
  tools: [grep],
});
