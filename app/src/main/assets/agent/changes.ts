/**
 * Change tracking for the agent's working directory, built on isomorphic-git
 * (the phone has no git binary). Every agent turn is bracketed by commits so any
 * turn can be inspected and undone, including changes made through `bash`.
 *
 * Commit message tags:
 *   [init]      first checkpoint of the shipped files
 *   [external]  changes found at startup (app update, "reset UI", manual edits)
 *   [edits]     changes made outside the agent, captured before a turn
 *   [turn]      what the agent changed during one prompt
 *   [undo]      a revert / restore (undoing one of these redoes the change)
 */

import git from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
import * as fs from "node:fs";
import { join } from "node:path";

export type ChangeKind = "init" | "external" | "edits" | "turn" | "undo";

/** One file's change in one commit. The flags are set for binary and oversized files. */
export interface FileDiff {
  patch: string;
  binary?: boolean;
  tooLarge?: boolean;
}

const BINARY_NOTE = "(binary file)";
const TOO_LARGE_NOTE = "(file too large to diff)";

export interface ChangeEntry {
  oid: string;
  kind: ChangeKind;
  summary: string;
  detail: string;
  timestamp: number;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface UndoResult {
  oid: string | null;
  reverted: string[];
  /** Files changed again by later work; left alone. */
  conflicts: string[];
}

// .tmp/ holds scratch scripts an agent writes while debugging; it is not part of the app, so it must not
// reach the checkpoint journal (or a saved bundle). Note gitignore only affects untracked files: anything
// already committed stays tracked until it is deleted from the tree.
const IGNORE = ["*.sqlite", "*.sqlite-*", "auth.json", "auth.json.tmp", ".installed_version", ".shipped_manifest.json", "node_modules/", "vendor/", "fallback/", "uploads/", ".tmp/", "pidroid-models.json", "pidroid-models.json.tmp"];
const AUTHOR = { name: "Pidroid", email: "pidroid@localhost" };
const MAX_DIFF_BYTES = 200_000;

const TAG = /^\[(init|external|edits|turn|undo)\]\s*/;

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export class Changes {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** Serializes every git operation; concurrent chat requests must not interleave commits. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Create the repo on first run and checkpoint the current files. */
  init(): Promise<void> {
    return this.run(async () => {
      const { dir } = this;
      if (!fs.existsSync(join(dir, ".git"))) await git.init({ fs, dir, defaultBranch: "main" });
      const ignorePath = join(dir, ".gitignore");
      const wanted = IGNORE.join("\n") + "\n";
      if (!fs.existsSync(ignorePath) || fs.readFileSync(ignorePath, "utf8") !== wanted) fs.writeFileSync(ignorePath, wanted);

      const hasCommits = await git.resolveRef({ fs, dir, ref: "HEAD" }).then(() => true, () => false);
      await this.commitAll(hasCommits ? "[external] Changes found at startup (app update, reset or manual edits)" : "[init] Shipped files");
    });
  }

  /** Commit everything that differs from HEAD. Resolves the new oid, or null when nothing changed. */
  snapshot(message: string): Promise<string | null> {
    return this.run(() => this.commitAll(message));
  }

  private async commitAll(message: string): Promise<string | null> {
    const { dir } = this;
    const matrix = await git.statusMatrix({ fs, dir });
    let dirty = false;
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      dirty = true;
      if (workdir === 0) await git.remove({ fs, dir, filepath });
      else await git.add({ fs, dir, filepath });
    }
    const hasHead = await git.resolveRef({ fs, dir, ref: "HEAD" }).then(() => true, () => false);
    if (!dirty && hasHead) return null;
    return git.commit({ fs, dir, message, author: AUTHOR });
  }

  async list(limit = 60): Promise<ChangeEntry[]> {
    const commits = await this.run(() => git.log({ fs, dir: this.dir, depth: limit }));
    return commits.map(({ oid, commit }) => {
      const kind = (TAG.exec(commit.message)?.[1] ?? "external") as ChangeKind;
      const [first, ...rest] = commit.message.replace(TAG, "").trim().split("\n");
      return { oid, kind, summary: first, detail: rest.join("\n").trim(), timestamp: commit.author.timestamp * 1000 };
    });
  }

  private async parentOf(oid: string): Promise<string | undefined> {
    const { commit } = await git.readCommit({ fs, dir: this.dir, oid });
    return commit.parent[0];
  }

  private async changedFiles(oid: string): Promise<FileChange[]> {
    const { dir } = this;
    const parent = await this.parentOf(oid);
    const trees = parent ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })] : [git.TREE({ ref: oid })];
    const out: FileChange[] = [];
    await git.walk({
      fs,
      dir,
      trees,
      map: async (path, entries) => {
        if (path === ".") return;
        const before = parent ? entries[0] : null;
        const after = parent ? entries[1] : entries[0];
        const types = await Promise.all([before?.type(), after?.type()]);
        if (types[0] === "tree" || types[1] === "tree") return; // descend into directories
        const [a, b] = await Promise.all([before?.oid(), after?.oid()]);
        if (a === b) return;
        out.push({ path, status: !a ? "added" : !b ? "deleted" : "modified" });
      },
    });
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  files(oid: string): Promise<FileChange[]> {
    return this.run(() => this.changedFiles(oid));
  }

  private async blobAt(oid: string | undefined, filepath: string): Promise<Uint8Array | undefined> {
    if (!oid) return undefined;
    try {
      return (await git.readBlob({ fs, dir: this.dir, oid, filepath })).blob;
    } catch {
      return undefined;
    }
  }

  /** A file's diff in one commit, as a unified patch with every line of context. */
  diff(oid: string, filepath: string): Promise<FileDiff> {
    return this.run(async () => {
      const [before, after] = await Promise.all([this.blobAt(await this.parentOf(oid), filepath), this.blobAt(oid, filepath)]);
      if ((before && isBinary(before)) || (after && isBinary(after))) return { patch: BINARY_NOTE, binary: true };
      if ((before?.length ?? 0) > MAX_DIFF_BYTES || (after?.length ?? 0) > MAX_DIFF_BYTES) return { patch: TOO_LARGE_NOTE, tooLarge: true };
      const text = (bytes?: Uint8Array) => (bytes ? Buffer.from(bytes).toString("utf8") : "");
      // Full-file context, deliberately. With 3 lines of context an unchanged run can never be longer
      // than the gap between two nearby changes, so there is nothing for the viewer to fold. Emitting
      // everything and folding afterwards (diffrows.foldContext, keep 3) keeps the 3-line margin
      // around each change and adds a placeholder for whatever was skipped.
      return { patch: createTwoFilesPatch(`a/${filepath}`, `b/${filepath}`, text(before), text(after), "", "", { context: Number.MAX_SAFE_INTEGER }) };
    });
  }

  private writeOrDelete(filepath: string, bytes: Uint8Array | undefined) {
    const target = join(this.dir, filepath);
    if (!bytes) {
      fs.rmSync(target, { force: true });
      return;
    }
    fs.mkdirSync(join(target, ".."), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  /** Revert only what `oid` changed. Files edited again since are reported as conflicts and left alone. */
  undo(oid: string): Promise<UndoResult> {
    return this.run(async () => {
      await this.commitAll("[edits] Changes made outside the agent");
      const parent = await this.parentOf(oid);
      const reverted: string[] = [];
      const conflicts: string[] = [];
      for (const { path } of await this.changedFiles(oid)) {
        const theirs = await this.blobAt(oid, path);
        const current = fs.existsSync(join(this.dir, path)) ? new Uint8Array(fs.readFileSync(join(this.dir, path))) : undefined;
        const unchanged = theirs && current ? Buffer.from(theirs).equals(Buffer.from(current)) : !theirs && !current;
        if (!unchanged) {
          conflicts.push(path);
          continue;
        }
        this.writeOrDelete(path, await this.blobAt(parent, path));
        reverted.push(path);
      }
      const summary = (await git.readCommit({ fs, dir: this.dir, oid })).commit.message.replace(TAG, "").split("\n")[0];
      const newOid = reverted.length ? await this.commitAll(`[undo] Reverted: ${summary}`) : null;
      return { oid: newOid, reverted, conflicts };
    });
  }

  /** Make the working tree match `oid` exactly (a new commit; nothing is lost). */
  restore(oid: string, label?: string): Promise<UndoResult> {
    return this.run(async () => {
      const { dir } = this;
      await this.commitAll("[edits] Changes made outside the agent");
      const reverted: string[] = [];
      await git.walk({
        fs,
        dir,
        trees: [git.TREE({ ref: "HEAD" }), git.TREE({ ref: oid })],
        map: async (path, [head, target]) => {
          if (path === ".") return;
          const types = await Promise.all([head?.type(), target?.type()]);
          if (types[0] === "tree" || types[1] === "tree") return;
          const [a, b] = await Promise.all([head?.oid(), target?.oid()]);
          if (a === b) return;
          this.writeOrDelete(path, b ? await this.blobAt(oid, path) : undefined);
          reverted.push(path);
        },
      });
      const summary = (await git.readCommit({ fs, dir, oid })).commit.message.replace(TAG, "").split("\n")[0];
      const newOid = reverted.length ? await this.commitAll(`[undo] ${label ?? `Restored to: ${summary}`}`) : null;
      return { oid: newOid, reverted, conflicts: [] };
    });
  }

  /** Undo the newest commit of any kind. Undoing an [undo] commit redoes the change. */
  async undoLatest(): Promise<UndoResult> {
    const [latest] = await this.list(1);
    if (!latest) return { oid: null, reverted: [], conflicts: [] };
    const parent = await this.run(() => this.parentOf(latest.oid));
    if (!parent) return { oid: null, reverted: [], conflicts: [] };
    return this.restore(parent, `Reverted: ${latest.summary.replace(/^(Reverted|Restored to): /, "")}`);
  }
}
