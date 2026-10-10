import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWorkspaceTree, WORKSPACE_COPY_LIMIT_BYTES } from "./workspace-copy.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pidroid-workspace-copy-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("copyWorkspaceTree", () => {
  test("copies nested and binary files, replacing the destination only after the copy is ready", async () => {
    const root = makeRoot();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(join(source, "nested"), { recursive: true });
    mkdirSync(destination);
    writeFileSync(join(source, "nested", "readme.md"), "hello\n");
    writeFileSync(join(source, "nested", "blob.bin"), Buffer.from([0, 255, 16, 42]));
    writeFileSync(join(destination, "old.txt"), "old destination");

    const result = await copyWorkspaceTree(
      new NodeExecutionEnv({ cwd: source }),
      source,
      new NodeExecutionEnv({ cwd: destination }),
      destination,
      BACKGROUND_CONTEXT,
    );

    expect(result).toEqual({ bytes: 10, files: 2 });
    expect(readFileSync(join(destination, "nested", "readme.md"), "utf8")).toBe("hello\n");
    expect([...readFileSync(join(destination, "nested", "blob.bin"))]).toEqual([0, 255, 16, 42]);
    expect(readdirSync(destination)).toEqual(["nested"]);
    expect(readdirSync(root).some((name) => name.startsWith("destination.pidroid-"))).toBe(false);
  });

  test("a symbolic link or transfer error leaves the existing destination untouched", async () => {
    const root = makeRoot();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "ordinary.txt"), "new");
    symlinkSync("ordinary.txt", join(source, "linked.txt"));
    writeFileSync(join(destination, "keep.txt"), "previous");

    await expect(copyWorkspaceTree(
      new NodeExecutionEnv({ cwd: source }),
      source,
      new NodeExecutionEnv({ cwd: destination }),
      destination,
      BACKGROUND_CONTEXT,
    )).rejects.toThrow("symbolic links are not supported");

    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("previous");
    expect(readdirSync(destination)).toEqual(["keep.txt"]);
    expect(readdirSync(root).some((name) => name.startsWith("destination.pidroid-"))).toBe(false);
  });

  test("refuses a workspace over 64 MiB without replacing the destination", async () => {
    const root = makeRoot();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    const oversized = join(source, "large.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, WORKSPACE_COPY_LIMIT_BYTES + 1);
    writeFileSync(join(destination, "keep.txt"), "previous");

    await expect(copyWorkspaceTree(
      new NodeExecutionEnv({ cwd: source }),
      source,
      new NodeExecutionEnv({ cwd: destination }),
      destination,
      BACKGROUND_CONTEXT,
    )).rejects.toThrow("64 MiB transfer limit");

    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("previous");
  });

  test("a missing source is an empty replacement workspace", async () => {
    const root = makeRoot();
    const source = join(root, "not-created-yet");
    const destination = join(root, "destination");
    mkdirSync(destination);
    writeFileSync(join(destination, "stale.txt"), "old");

    const result = await copyWorkspaceTree(
      new NodeExecutionEnv({ cwd: root }),
      source,
      new NodeExecutionEnv({ cwd: destination }),
      destination,
      BACKGROUND_CONTEXT,
    );

    expect(result).toEqual({ bytes: 0, files: 0 });
    expect(readdirSync(destination)).toEqual([]);
  });
});
