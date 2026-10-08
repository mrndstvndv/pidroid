/**
 * Change tracking for the agent's working directory, built on isomorphic-git
 * (the phone has no git binary).
 *
 * Commits are deliberate. The agent commits chosen paths with `checkpoint`; startup captures whatever changed
 * while no agent was running (see init); and an app update is reconciled against the agent's history (see
 * importBundle). Edits are on disk as soon as they are written, so a crash loses nothing that was written.
 *
 * Refs: `main` is the agent's history. `shipped` is the bundle the app last reconciled, one commit per bundle, so the
 * base of the next update is always the previous bundle, whatever the agent has committed since.
 *
 * Commit message tags:
 *   [init]      first checkpoint of the shipped files
 *   [external]  changes found at startup (crash, manual edits, reset)
 *   [update]    the app update, applied or resolved against the agent's files
 *   [edits]     changes made outside the agent, captured before a revert or an update
 *   [turn]      a checkpoint the agent committed
 *   [undo]      a revert / restore (undoing one of these redoes the change)
 *   [shipped]   a bundle, or the base an update is merged against: kept for the merges, not listed
 */

import git from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

export type ChangeKind = "init" | "external" | "edits" | "turn" | "update" | "undo";

/** One file's change in one commit. `before`/`after` are absent for binary and oversized files. */
export interface FileDiff {
  patch: string;
  before?: string;
  after?: string;
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

export interface PendingChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface UndoResult {
  oid: string | null;
  reverted: string[];
  /** Files changed again by later work; left alone. */
  conflicts: string[];
}

/** An app update, as the agent's files see it. `pending` waits for a choice; `merging` has a session resolving it. */
export interface UpdateStatus {
  stage: "pending" | "merging" | null;
  conflicts: string[];
  /** The bundle waiting to be applied, and the one last applied. */
  stamp?: string;
  applied?: string;
}

export interface UpdateOutcome {
  status: "applied" | "pending" | "merging";
  conflicts: string[];
  oid?: string | null;
}

// .tmp/ holds scratch scripts an agent writes while debugging; it is not part of the app, so it must not
// reach the checkpoint journal (or a saved bundle). Note gitignore only affects untracked files: anything
// already committed stays tracked until it is deleted from the tree.
const IGNORE = [
  "*.sqlite", "*.sqlite-*", "auth.json", "auth.json.tmp", ".installed_version", ".shipped_manifest.json",
  ".update.json", ".applied_stamp", "node_modules/", "vendor/", "fallback/", "uploads/", ".tmp/",
  "pidroid-models.json", "pidroid-models.json.tmp",
];
const AUTHOR = { name: "Pidroid", email: "pidroid@localhost" };
const MAX_DIFF_BYTES = 200_000;

const TAG = /^\[(init|external|edits|turn|update|undo|shipped)\]\s*/;

/** Written by the app next to a staged bundle: the stamp of the install it came from. Not part of the bundle's files. */
const BUNDLE_STAMP_FILE = ".stamp";
const MANIFEST_FILE = ".shipped_manifest.json";
/** Where the bundled copy of each conflicting file is written during a merge, beside the agent's own copy. */
const MERGE_DIR = ".tmp/merge";
const SHIPPED_REF = "refs/heads/shipped";
const STATE_FILE = ".update.json";
const APPLIED_FILE = ".applied_stamp";

interface UpdateState {
  stage: "pending" | "merging";
  stamp: string;
  /** The bundle's commit, and the shipped commit it is merged against. */
  bundle: string;
  base: string;
  conflicts: string[];
  /** While merging: the agent's HEAD when the merge began, the first parent of the merge commit. */
  ours?: string;
}

/** A file as one tree holds it. Mode is the git mode in octal ("100644"). */
interface Entry {
  oid: string;
  mode: string;
}

/** Shape of the tree walker entries isomorphic-git hands to `walk` callbacks. */
interface TreeEntry {
  type(): Promise<string>;
  oid(): Promise<string>;
  mode(): Promise<number>;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Whether a repo path is excluded by IGNORE, with the same meaning .gitignore gives these patterns. */
function ignored(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return IGNORE.some((pattern) => {
    if (pattern.endsWith("/")) return parts.includes(pattern.slice(0, -1));
    if (pattern.includes("*")) return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(name);
    return name === pattern;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a changed-path filter (a file or a directory, "." for everything) selects `path`. */
function selects(paths: string[]): (path: string) => boolean {
  return (path) => paths.some((wanted) => wanted === "." || path === wanted || path.startsWith(`${wanted.replace(/\/$/, "")}/`));
}

/**
 * Unchanged-looking files whose mtime is not older than .git/index (second granularity, as git compares them). Their
 * stat cannot prove they are unchanged: a write in the same second as the index, at the same size, leaves it intact.
 */
function racyPaths(matrix: [string, number, number, number][], dir: string): string[] {
  const indexPath = join(dir, ".git", "index");
  if (!fs.existsSync(indexPath)) return [];
  const indexSecond = Math.floor(fs.statSync(indexPath).mtimeMs / 1000);
  return matrix
    .filter(([filepath, head, workdir, stage]) => {
      if (head !== 1 || workdir !== 1 || stage !== 1) return false;
      // The agent's shell can delete a file between the status scan and this stat; the normal pass handles that.
      try {
        return Math.floor(fs.statSync(join(dir, filepath)).mtimeMs / 1000) >= indexSecond;
      } catch {
        return false;
      }
    })
    .map(([filepath]) => filepath);
}

async function blobEntry(entry: TreeEntry | null): Promise<Entry | undefined> {
  if (!entry || (await entry.type()) !== "blob") return undefined;
  return { oid: await entry.oid(), mode: (await entry.mode()).toString(8) };
}

/** Same content. Mode is ignored: the bundle carries no executable bits, so a mode alone is never a change to report. */
const sameEntry = (a?: Entry, b?: Entry) => a?.oid === b?.oid;

/**
 * Three-way comparison of the trees at `base`, `ours` and `theirs`, one file at a time. A file only one side changed
 * takes that side (a deletion included); a file both sides changed differently is a conflict. Nothing is written.
 */
async function classify(dir: string, base: string, ours: string, theirs: string) {
  const take = new Map<string, Entry | undefined>();
  const conflicts = new Map<string, { ours?: Entry; theirs?: Entry }>();
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: base }), git.TREE({ ref: ours }), git.TREE({ ref: theirs })],
    map: async (path, [b, o, t]) => {
      // Not shipped: .gitignore is written by init, and ignored paths are the app's own state (sessions, update state).
      if (path === "." || path === ".gitignore" || ignored(path)) return;
      const types = await Promise.all([b?.type(), o?.type(), t?.type()]);
      if (types.includes("tree")) return; // directories: their files are visited on their own
      const [be, oe, te] = await Promise.all([blobEntry(b), blobEntry(o), blobEntry(t)]);
      if (sameEntry(oe, te)) return;
      if (sameEntry(be, oe)) take.set(path, te);
      else if (sameEntry(be, te)) return;
      else conflicts.set(path, { ours: oe, theirs: te });
    },
  });
  return { take, conflicts };
}

type Node = Map<string, Node | Entry>;

/** Nests flat repo paths into directories, ready to be written as trees. */
function nest(files: Map<string, Entry>): Node {
  const root: Node = new Map();
  for (const [path, entry] of files) {
    const parts = path.split("/");
    let node = root;
    for (const name of parts.slice(0, -1)) {
      let child = node.get(name);
      if (!(child instanceof Map)) {
        child = new Map();
        node.set(name, child);
      }
      node = child;
    }
    node.set(parts[parts.length - 1], entry);
  }
  return root;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

function pruneEmptyDirs(root: string, dir: string) {
  while (dir.startsWith(root + "/") && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = dirname(dir);
  }
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

  /**
   * Create the repo on first run and checkpoint the shipped files. Later runs commit what differs from HEAD only
   * when `captureLeftovers` is set, so changes made while no agent was running (crash, manual edits, reset) get their
   * own [external] commit instead of being folded into the agent's next checkpoint. A planned restart passes false:
   * its uncommitted edits are the agent's to checkpoint.
   */
  init(captureLeftovers = true): Promise<void> {
    return this.run(async () => {
      const { dir } = this;
      if (!fs.existsSync(join(dir, ".git"))) await git.init({ fs, dir, defaultBranch: "main" });
      const ignorePath = join(dir, ".gitignore");
      const wanted = IGNORE.join("\n") + "\n";
      if (!fs.existsSync(ignorePath) || fs.readFileSync(ignorePath, "utf8") !== wanted) fs.writeFileSync(ignorePath, wanted);

      if (!(await this.hasHead())) await this.commitAll("[init] Shipped files");
      else if (captureLeftovers && this.readState()?.stage !== "merging") {
        await this.commitAll("[external] Changes found at startup (crash, manual edits or reset)");
      }
    });
  }

  private async hasHead(): Promise<boolean> {
    return git.resolveRef({ fs, dir: this.dir, ref: "HEAD" }).then(() => true, () => false);
  }

  private head(): Promise<string> {
    return git.resolveRef({ fs, dir: this.dir, ref: "HEAD" });
  }

  private shippedTip(): Promise<string | undefined> {
    return git.resolveRef({ fs, dir: this.dir, ref: SHIPPED_REF }).catch(() => undefined);
  }

  private readState(): UpdateState | undefined {
    const file = join(this.dir, STATE_FILE);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as UpdateState) : undefined;
  }

  private writeState(state: UpdateState) {
    fs.writeFileSync(join(this.dir, STATE_FILE), JSON.stringify(state));
  }

  /** Commits made during a merge would bake half-merged files into history, so they wait for complete_merge. */
  private assertNotMerging() {
    if (this.readState()?.stage === "merging") {
      throw new Error("An app update is being merged: resolve the conflicts and complete the merge first.");
    }
  }

  /**
   * Stage the changed paths `include` selects (all by default) and return how many. Files whose stat cannot be trusted
   * are re-hashed; one that turns out changed is staged only if it was selected, so an unselected file never leaks
   * into a selective commit.
   */
  private async stage(include: (path: string) => boolean = () => true): Promise<number> {
    const { dir } = this;
    let matrix = await git.statusMatrix({ fs, dir });
    // isomorphic-git calls a file unchanged when its stat matches the index, so an edit made in the same second as
    // the last index write, at the same size, would be missed. Re-hash those files, as git does ("racy" entries).
    const racy = racyPaths(matrix, dir);
    if (racy.length) {
      for (const filepath of racy) await git.add({ fs, dir, filepath });
      for (const filepath of racy) if (!include(filepath)) await git.resetIndex({ fs, dir, filepath });
      matrix = await git.statusMatrix({ fs, dir });
    }
    let staged = 0;
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (!include(filepath)) continue;
      staged++;
      if (workdir === 0) await git.remove({ fs, dir, filepath });
      else await git.add({ fs, dir, filepath });
    }
    return staged;
  }

  /** Stage everything that differs from HEAD and commit it. Resolves null when nothing changed (once HEAD exists). */
  private async commitAll(message: string, parent?: string[]): Promise<string | null> {
    const staged = await this.stage();
    if (!staged && (await this.hasHead())) return null;
    return git.commit({ fs, dir: this.dir, message, author: AUTHOR, parent });
  }

  /**
   * The agent's checkpoint: commit the changed paths (all of them when `paths` is omitted), and leave the rest
   * uncommitted. Resolves the new oid, or null when none of the selected paths changed.
   */
  snapshot(message: string, paths?: string[]): Promise<string | null> {
    return this.run(async () => {
      this.assertNotMerging();
      const staged = await this.stage(paths ? selects(paths) : undefined);
      if (!staged) return null;
      return git.commit({ fs, dir: this.dir, message, author: AUTHOR });
    });
  }

  /** Changed files not yet in history, for the agent to choose from. */
  pendingChanges(): Promise<PendingChange[]> {
    return this.run(async () => {
      await this.stage(() => false); // settles racy files without staging anything
      const matrix = await git.statusMatrix({ fs, dir: this.dir });
      return matrix
        .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
        .map(([path, head, workdir]) => ({ path, status: head === 0 ? "added" : workdir === 0 ? "deleted" : "modified" }) as PendingChange);
    });
  }

  async list(limit = 60): Promise<ChangeEntry[]> {
    const commits = await this.run(() => git.log({ fs, dir: this.dir, depth: limit }));
    // [shipped] commits are the bundles an update was merged from: merge commits already describe them, so they are not listed.
    return commits
      .filter(({ commit }) => TAG.exec(commit.message)?.[1] !== "shipped")
      .map(({ oid, commit }) => {
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

  /**
   * A file's diff in one commit, as a unified patch plus both file versions.
   *
   * The patch alone is not enough to colour a diff properly: to paint a `-` line with the grammar
   * that applies to the file, you need the *old* file tokenised, and to paint a `+` line you need
   * the new one. Both sides are returned so the caller can do that with one grammar instead of
   * falling back to highlighting the patch itself, which only knows it is "a diff".
   */
  diff(oid: string, filepath: string): Promise<FileDiff> {
    return this.run(async () => {
      const [before, after] = await Promise.all([this.blobAt(await this.parentOf(oid), filepath), this.blobAt(oid, filepath)]);
      if ((before && isBinary(before)) || (after && isBinary(after))) return { patch: BINARY_NOTE, binary: true };
      if ((before?.length ?? 0) > MAX_DIFF_BYTES || (after?.length ?? 0) > MAX_DIFF_BYTES) return { patch: TOO_LARGE_NOTE, tooLarge: true };
      const text = (bytes?: Uint8Array) => (bytes ? Buffer.from(bytes).toString("utf8") : "");
      return {
        // Full-file context, deliberately. `context: 3` is the right answer for a patch you are
        // going to read as a wall of text, and the wrong answer for one a viewer will fold: with 3
        // lines of context an unchanged run can never be longer than the gap between two nearby
        // changes, so there is nothing to collapse. Emitting everything and folding afterwards
        // (diffrows.foldContext, keep 3) gives the same 3-line margin around each change *plus* a
        // placeholder for whatever was skipped -- and costs no extra work here, because both files
        // are tokenised in full anyway to colour the two sides.
        patch: createTwoFilesPatch(`a/${filepath}`, `b/${filepath}`, text(before), text(after), "", "", { context: Number.MAX_SAFE_INTEGER }),
        before: text(before),
        after: text(after),
      };
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
      this.assertNotMerging();
      const { commit: change } = await git.readCommit({ fs, dir: this.dir, oid });
      if (change.message.startsWith("[update]")) {
        throw new Error("That is an app update, which is the app's own change. Undo the agent's changes around it instead.");
      }
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
    return this.run(() => this.restoreTree(oid, label));
  }

  /**
   * An applied app update is the app's change, not the agent's. Moving the agent's files back across one would leave
   * them out of step with the bundle the app runs, so such a move is refused. `target` is the state being moved to.
   */
  private async assertNoUpdateSince(target: string) {
    const history = await git.log({ fs, dir: this.dir, depth: 1000 });
    for (const { oid, commit } of history) {
      if (oid === target) return;
      if (commit.message.startsWith("[update]")) {
        throw new Error("That would undo an app update, which is the app's own change. Undo the agent's changes around it instead.");
      }
    }
  }

  /** The body of restore, for callers that already hold the queue. */
  private async restoreTree(oid: string, label?: string): Promise<UndoResult> {
    this.assertNotMerging();
    await this.assertNoUpdateSince(oid);
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
  }

  /**
   * Undo the newest change of any kind. Uncommitted edits count as the newest change: they are committed first, so
   * nothing is lost, and then that commit is reverted. The result is the last checkpoint with the edits still in
   * history. Undoing an [undo] commit redoes the change.
   */
  undoLatest(): Promise<UndoResult> {
    return this.run(async () => {
      this.assertNotMerging();
      const none: UndoResult = { oid: null, reverted: [], conflicts: [] };
      await this.commitAll("[edits] Changes made outside the agent");
      if (!(await this.hasHead())) return none;
      const [latest] = await git.log({ fs, dir: this.dir, depth: 1 });
      const parent = latest?.commit.parent[0];
      if (!latest || !parent) return none;
      const summary = latest.commit.message.replace(TAG, "").trim().split("\n")[0];
      return this.restoreTree(parent, `Reverted: ${summary.replace(/^(Reverted|Restored to): /, "")}`);
    });
  }

  // ---- app updates -------------------------------------------------------------------------------------------------

  /**
   * Reconcile a staged app bundle (a directory of the shipped files) with the agent's history. The bundle becomes a
   * commit on `shipped`; the agent's files are three-way merged against the previous bundle. If nothing conflicts the
   * result is applied at once, as a merge commit. If something does, nothing is written: the state waits for
   * keepAgent, useBundled or beginMerge.
   */
  importBundle(bundleDir: string, stamp: string): Promise<UpdateOutcome> {
    return this.run(async () => {
      const state = this.readState();
      if (state?.stage === "merging") return { status: "merging", conflicts: state.conflicts };
      const tree = await this.writeDirTree(bundleDir);
      if (!tree) throw new Error(`The bundle at ${bundleDir} has no files`);
      const base = (await this.shippedTip()) ?? (await this.reconstructBase());
      const bundle = await this.commitTree(tree, [base], `[shipped] Bundle ${stamp}`);
      // Uncommitted edits are captured before anything is compared or written, as undo does.
      await this.commitAll("[edits] Changes made outside the agent");
      const ours = await this.head();
      const { take, conflicts } = await classify(this.dir, base, ours, bundle);
      if (conflicts.size) {
        const paths = [...conflicts.keys()].sort();
        this.writeState({ stage: "pending", stamp, bundle, base, conflicts: paths });
        return { status: "pending", conflicts: paths };
      }
      await this.writeWorktree(take);
      const staged = await this.stage();
      const oid = staged ? await git.commit({ fs, dir: this.dir, message: `[update] Applied app update ${stamp}`, author: AUTHOR, parent: [ours, bundle] }) : null;
      await this.finishUpdate(bundle, stamp);
      return { status: "applied", conflicts: [], oid };
    });
  }

  /** Keep the agent's version of every conflicting file, and apply the rest of the update. */
  keepAgent(): Promise<UpdateOutcome> {
    return this.resolve("keep");
  }

  /** Use the bundled version of every conflicting file, and apply the rest of the update. */
  useBundled(): Promise<UpdateOutcome> {
    return this.resolve("bundled");
  }

  private resolve(choice: "keep" | "bundled"): Promise<UpdateOutcome> {
    return this.run(async () => {
      const state = this.readState();
      if (state?.stage !== "pending") throw new Error("No app update is waiting for a choice.");
      await this.commitAll("[edits] Changes made outside the agent");
      const ours = await this.head();
      const { take, conflicts } = await classify(this.dir, state.base, ours, state.bundle);
      if (choice === "bundled") for (const [path, sides] of conflicts) take.set(path, sides.theirs);
      await this.writeWorktree(take);
      await this.stage();
      const paths = [...conflicts.keys()].sort();
      const verb = choice === "keep" ? "Kept the agent's version of" : "Used the bundled version of";
      const message = `[update] ${verb} ${paths.length} conflicting file(s) from app update ${state.stamp}${paths.length ? `\n\n${paths.join("\n")}` : ""}`;
      const oid = await git.commit({ fs, dir: this.dir, message, author: AUTHOR, parent: [ours, state.bundle] });
      await this.finishUpdate(state.bundle, state.stamp);
      return { status: "applied", conflicts: paths, oid };
    });
  }

  /**
   * Start resolving by hand: the agent's versions of the conflicting files stay in place, the bundled ones are written
   * to .tmp/merge/ beside them, and the clean part of the update is applied. Commits wait until completeMerge.
   */
  beginMerge(): Promise<{ conflicts: string[]; dir: string }> {
    return this.run(async () => {
      const state = this.readState();
      if (state?.stage === "merging") return { conflicts: state.conflicts, dir: MERGE_DIR };
      if (state?.stage !== "pending") throw new Error("No app update is waiting for a choice.");
      await this.commitAll("[edits] Changes made outside the agent");
      const ours = await this.head();
      const { take, conflicts } = await classify(this.dir, state.base, ours, state.bundle);
      await this.writeWorktree(take);
      for (const [path, sides] of conflicts) {
        if (!sides.theirs) continue; // the update deleted it: there is no bundled copy to show
        const { blob } = await git.readBlob({ fs, dir: this.dir, oid: sides.theirs.oid });
        const target = join(this.dir, MERGE_DIR, path);
        fs.mkdirSync(dirname(target), { recursive: true });
        fs.writeFileSync(target, blob);
      }
      const paths = [...conflicts.keys()].sort();
      this.writeState({ ...state, stage: "merging", ours, conflicts: paths });
      return { conflicts: paths, dir: MERGE_DIR };
    });
  }

  /** Commit the merge begun by beginMerge, with both sides as parents. `message` is the full commit message. */
  completeMerge(message: string): Promise<string> {
    return this.run(async () => {
      const state = this.readState();
      if (state?.stage !== "merging" || !state.ours) throw new Error("No app update merge is in progress.");
      await this.stage();
      const oid = await git.commit({ fs, dir: this.dir, message, author: AUTHOR, parent: [state.ours, state.bundle] });
      fs.rmSync(join(this.dir, MERGE_DIR), { recursive: true, force: true });
      await this.finishUpdate(state.bundle, state.stamp);
      return oid;
    });
  }

  /**
   * Give up a merge in progress without losing its work: what is in the working tree is saved as an [edits] commit, and
   * the update is waiting for a choice again. Its conflicts are then worked out afresh from that saved state.
   */
  cancelMerge(): Promise<UpdateOutcome> {
    return this.run(async () => {
      const state = this.readState();
      if (state?.stage !== "merging") throw new Error("No app update merge is in progress.");
      await this.commitAll("[edits] Merge work saved when the merge was cancelled");
      fs.rmSync(join(this.dir, MERGE_DIR), { recursive: true, force: true });
      this.writeState({ stage: "pending", stamp: state.stamp, bundle: state.bundle, base: state.base, conflicts: [] });
      return { status: "pending", conflicts: [] };
    });
  }

  updateStatus(): Promise<UpdateStatus> {
    return this.run(async () => {
      const state = this.readState();
      let conflicts = state?.conflicts ?? [];
      if (state?.stage === "pending") {
        // Recomputed: the agent may have changed some of these files since the update was staged.
        const { conflicts: now } = await classify(this.dir, state.base, await this.head(), state.bundle);
        conflicts = [...now.keys()].sort();
      }
      return { stage: state?.stage ?? null, conflicts, stamp: state?.stamp, applied: readText(join(this.dir, APPLIED_FILE)) };
    });
  }

  private async finishUpdate(bundle: string, stamp: string) {
    await git.writeRef({ fs, dir: this.dir, ref: SHIPPED_REF, value: bundle, force: true });
    fs.writeFileSync(join(this.dir, APPLIED_FILE), stamp);
    fs.rmSync(join(this.dir, STATE_FILE), { force: true });
    fs.rmSync(join(this.dir, MERGE_DIR), { recursive: true, force: true });
  }

  /** Write the files of `take` into the working tree. Deleted files also lose their now-empty directories. */
  private async writeWorktree(take: Map<string, Entry | undefined>) {
    for (const [path, entry] of take) {
      const target = join(this.dir, path);
      if (!entry) {
        fs.rmSync(target, { force: true });
        pruneEmptyDirs(this.dir, dirname(target));
        continue;
      }
      const { blob } = await git.readBlob({ fs, dir: this.dir, oid: entry.oid });
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(target, blob);
    }
  }

  /** The tree of a bundle directory, written to the object store. Undefined when it holds no shipped files. */
  private async writeDirTree(root: string, rel = ""): Promise<string | undefined> {
    const tree: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
    for (const name of fs.readdirSync(join(root, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (!rel && name === BUNDLE_STAMP_FILE) continue;
      if (ignored(path)) continue;
      const full = join(root, path);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const oid = await this.writeDirTree(root, path);
        if (oid) tree.push({ mode: "40000", path: name, oid, type: "tree" });
      } else if (stat.isFile()) {
        const oid = await git.writeBlob({ fs, dir: this.dir, blob: new Uint8Array(fs.readFileSync(full)) });
        tree.push({ mode: "100644", path: name, oid, type: "blob" });
      }
    }
    return tree.length ? git.writeTree({ fs, dir: this.dir, tree }) : undefined;
  }

  private async writeNode(node: Node): Promise<string> {
    const tree: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
    for (const [name, child] of node) {
      if (child instanceof Map) tree.push({ mode: "40000", path: name, oid: await this.writeNode(child), type: "tree" });
      else tree.push({ mode: child.mode, path: name, oid: child.oid, type: "blob" });
    }
    return git.writeTree({ fs, dir: this.dir, tree });
  }

  private async commitTree(tree: string, parent: string[], message: string): Promise<string> {
    const now = { timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() };
    return git.writeCommit({
      fs,
      dir: this.dir,
      commit: { message, tree, parent, author: { ...AUTHOR, ...now }, committer: { ...AUTHOR, ...now } },
    });
  }

  /**
   * The shipped commit for a repo that has no shipped ref yet. With the manifest the last extraction wrote, it is
   * rebuilt: a file the agent has not touched is its live content, which is what was shipped; a file it has touched
   * takes its [init] content, so an update to it becomes a conflict, not a silent overwrite. Without a manifest nothing
   * is known to have been shipped, so the base is empty: every file the update ships that differs from the agent's is
   * then a conflict, and everything the agent made is kept.
   */
  private async reconstructBase(): Promise<string> {
    const manifestFile = join(this.dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestFile)) {
      const empty = await git.writeTree({ fs, dir: this.dir, tree: [] });
      return this.commitTree(empty, [], "[shipped] Base: no shipped files recorded");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, string>;
    const history = await git.log({ fs, dir: this.dir });
    const first = history[history.length - 1]?.oid;
    const files = new Map<string, Entry>();
    for (const [path, shippedHash] of Object.entries(manifest)) {
      if (ignored(path)) continue;
      const live = join(this.dir, path);
      if (fs.existsSync(live)) {
        const bytes = new Uint8Array(fs.readFileSync(live));
        if (createHash("sha256").update(bytes).digest("hex") === shippedHash) {
          files.set(path, { oid: await git.writeBlob({ fs, dir: this.dir, blob: bytes }), mode: "100644" });
          continue;
        }
      }
      if (!first) continue;
      try {
        const { oid } = await git.readBlob({ fs, dir: this.dir, oid: first, filepath: path });
        files.set(path, { oid, mode: "100644" });
      } catch {
        // The first checkpoint did not have it either: a file the agent created, so there is no shipped base for it.
      }
    }
    const tree = await this.writeNode(nest(files));
    return this.commitTree(tree, [], "[shipped] Base: reconstructed before update tracking");
  }
}
