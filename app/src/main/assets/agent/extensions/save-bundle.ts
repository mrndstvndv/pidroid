/**
 * save_bundle: snapshot the agent's source files out to shared storage as a tarball.
 *
 * Why this exists: the agent's work only lives in the app sandbox, where an app update can
 * overwrite it (changes.ts commits the drift as "[external] Changes found at startup"). The
 * checkpoint journal at files/agent/.git is a per-turn log, not somewhere to put real work —
 * there is no git binary on this device and no remote. So this writes an ordinary archive to
 * /storage/emulated/0/Download that can be pulled onto a desktop and committed there.
 *
 * Every source file goes in. There is no "changed only" mode: the point of the archive is to be a
 * complete, self-contained copy of the work, and a partial one that silently omits a file the agent
 * forgot to touch is worse than a slightly larger tarball. Credentials, session databases, .git,
 * scratch directories and generated bundles are still left out.
 *
 * Each file is labelled against `.shipped_manifest.json`, the app's map of path -> sha256 for its
 * shipped files, so the archive says which files are the agent's work ("modified"), which are app
 * assets the app ships without hashing ("not-shipped"), and which shipped files are gone
 * ("deleted"). Only "deleted" entries are left out of the archive itself -- there is nothing on
 * disk to copy -- but they are listed in the manifest. The app's git index is not a usable
 * baseline: it gains files whenever the app updates, and changes.ts commits it every turn.
 *
 * Secrets are never included: auth.json (API keys), the sqlite databases, the local .git, and
 * the generated bundle directories are excluded — the same list changes.ts keeps out of its
 * commits.
 *
 * tar runs as a child process and is awaited, so the server's event loop is not blocked.
 *
 * After editing, call reload_extensions. No restart needed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { readdir, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

/** The agent directory: the parent of extensions/. */
const AGENT_DIR = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");

/** Where archives land. */
const DOWNLOAD_DIR = "/storage/emulated/0/Download";

/** Directories never included: VCS internals, deps, generated bundles, scratch. */
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "fallback", ".bun", ".tmp", ".bundle-staging"]);

/** Files never included: credentials, installed-state markers, the shipped hash map. */
const SKIP_FILES = new Set(["auth.json", "auth.json.tmp", ".installed_version", ".shipped_manifest.json"]);

/** Session/history databases and their write-ahead logs. */
const SKIP_SUFFIXES = [".sqlite", ".sqlite-shm", ".sqlite-wal"];

function isSkipped(name: string): boolean {
  return SKIP_FILES.has(name) || SKIP_SUFFIXES.some((s) => name.endsWith(s));
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, out);
    } else if (entry.isFile() && !isSkipped(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function sha256(buf: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pidroid-agent";
}

const saveBundle = defineTool({
  name: "save_bundle",
  description:
    "Snapshot every source file of the app to a <name>.tar.gz in /storage/emulated/0/Download so the " +
    "work can be pulled onto a desktop and committed to a real repo. This is the escape hatch: the " +
    "agent's work normally lives only in the app sandbox, where an app update can overwrite it, and " +
    "the local commit journal is a per-turn log with no remote. The archive is always the complete " +
    "tree -- there is no partial mode -- and carries a MANIFEST.json labelling each file against the " +
    "app's shipped baseline (.shipped_manifest.json). Credentials (auth.json), session databases, " +
    "the local .git, scratch directories and generated bundles are always excluded.",
  parameters: Type.Object({
    name: Type.Optional(
      Type.String({ description: "Filename prefix (default 'pidroid-agent-changes'); a UTC timestamp is appended" }),
    ),
  }),
  execute: async (args, api) => {
    const base = safeName(String(args.name ?? "pidroid-agent-changes"));
    const stamp = timestamp();

    let manifest: Record<string, string>;
    try {
      manifest = JSON.parse(await Bun.file(join(AGENT_DIR, ".shipped_manifest.json")).text());
    } catch {
      manifest = {};
    }

    const records: { path: string; status: string; sha256: string; bytes: number }[] = [];
    const seen = new Set<string>();
    for (const full of await walk(AGENT_DIR)) {
      const rel = full.slice(AGENT_DIR.length + 1);
      seen.add(rel);
      const buf = new Uint8Array(await Bun.file(full).arrayBuffer());
      const hash = sha256(buf);
      const shipped = manifest[rel];
      const status = shipped === undefined ? "not-shipped" : shipped === hash ? "unchanged" : "modified";
      records.push({ path: rel, status, sha256: hash, bytes: buf.byteLength });
    }
    for (const rel of Object.keys(manifest)) {
      if (seen.has(rel)) continue;
      const head = rel.split("/")[0];
      if (SKIP_DIRS.has(head) || isSkipped(rel)) continue; // excluded by design, not deleted
      records.push({ path: rel, status: "deleted", sha256: manifest[rel], bytes: 0 });
    }

    // Everything on disk goes in, except entries that only exist in the manifest: a shipped file
    // that is now gone has nothing to copy, so it is reported rather than archived.
    const selected = records.filter((r) => r.status !== "deleted");
    if (!selected.length) {
      api.output("Nothing to bundle: no source files found.");
      return {};
    }

    const stageName = `${base}-${stamp}`;
    const stage = join(AGENT_DIR, ".bundle-staging", stageName);
    try {
      for (const rec of selected) {
        if (rec.status === "deleted") continue; // reported in the manifest, nothing on disk to copy
        const dest = join(stage, "files", rec.path);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(AGENT_DIR, rec.path), dest);
      }

      // The working directory is not a stable thing to read: a concurrent agent session (or a
      // hand edit, or an app update) rewrites these files while we walk them, and the app briefly
      // restores shipped copies mid-turn. A naive copy is therefore a torn snapshot from several
      // different points in time. Re-hash every source after copying and report anything that moved,
      // so a bundle is never silently inconsistent.
      const unstable: { path: string; expected: string; actual: string }[] = [];
      for (const rec of selected) {
        if (rec.status === "deleted") continue;
        const now = sha256(new Uint8Array(await Bun.file(join(AGENT_DIR, rec.path)).arrayBuffer()));
        if (now !== rec.sha256) unstable.push({ path: rec.path, expected: rec.sha256, actual: now });
      }

      const modified = selected.filter((r) => r.status === "modified").length;
      const added = selected.filter((r) => r.status === "not-shipped").length;
      const deleted = selected.filter((r) => r.status === "deleted").length;
      await writeFile(
        join(stage, "MANIFEST.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            agentDir: AGENT_DIR,
            baseline: ".shipped_manifest.json (sha256 map of the app's shipped files)",
            counts: { included: selected.length, modified, notShipped: added, deleted },
            note: "Full source snapshot of the agent's files.",
            statusLegend: {
              modified: "hash differs from the shipped baseline",
              "not-shipped": "not in the shipped manifest (app asset, or a file added since install)",
              deleted: "in the shipped manifest but missing on disk",
              unchanged: "identical to the shipped baseline (app file, untouched)",
            },
            excluded: [
              "auth.json (credentials)",
              "*.sqlite (sessions)",
              ".git",
              "node_modules",
              ".tmp (scratch)",
              "generated bundles",
            ],
            files: selected.sort((a, b) => a.path.localeCompare(b.path)),
            unstableDuringCopy: unstable,
          },
          null,
          2,
        ),
      );

      await mkdir(DOWNLOAD_DIR, { recursive: true });
      const outPath = join(DOWNLOAD_DIR, `${stageName}.tar.gz`);
      const proc = Bun.spawn(["tar", "czf", outPath, "-C", dirname(stage), stageName], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const err = await new Response(proc.stderr).text();
      if (code !== 0) throw new Error(`tar exited ${code}: ${err.trim() || "no stderr"}`);

      const size = (await Bun.file(outPath).arrayBuffer()).byteLength;
      api.output(
        [
          `Bundle written: ${outPath}`,
          `  ${selected.length} files, ${(size / 1024).toFixed(1)} KB, MANIFEST.json inside`,
          ...(unstable.length
            ? [
                `  WARNING: ${unstable.length} file(s) changed while this bundle was being written:`,
                ...unstable.map((u) => `    ${u.path}`),
                "  Another session or the app is editing right now - this snapshot is torn.",
                "  Close the other session and run save_bundle again.",
              ]
            : []),
        ].join("\n"),
      );
    } finally {
      await rm(join(AGENT_DIR, ".bundle-staging"), { recursive: true, force: true });
    }
    return {};
  },
});

export default defineExtension({
  name: "save-bundle",
  tools: [saveBundle],
});
