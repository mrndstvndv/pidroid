import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, FileError, FileInfo, Result } from "@earendil-works/pi-durable/env";

/** Workspace copies go through the phone, so bound how much data a single transfer can move. */
export const WORKSPACE_COPY_LIMIT_BYTES = 64 * 1024 * 1024;

type WorkspaceEnv = Pick<
  ExecutionEnv,
  "exists" | "fileInfo" | "joinPath" | "listDir" | "createDir" | "readBinaryFile" | "writeFile" | "renameFile" | "remove"
>;

function unwrap<T>(result: Result<T, FileError>, operation: string): T {
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`);
  return result.value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make a replacement copy of a session workspace using the ExecutionEnv file APIs. That keeps phone↔machine and
 * machine↔machine transfers on the same pi-env path, without involving a shell or interpolating workspace names into
 * commands. Build beside the destination and rename only after the whole tree is ready, so a failed transfer leaves
 * both the active session and the destination's previous workspace intact.
 *
 * Symbolic links are refused rather than silently dereferenced: copying one could escape the workspace root, and the
 * ExecutionEnv file API has no portable operation for recreating a link. The app's branch-copy limit is reused here.
 */
export async function copyWorkspaceTree(
  source: WorkspaceEnv,
  sourceRoot: string,
  destination: WorkspaceEnv,
  destinationRoot: string,
  context: Context,
): Promise<{ bytes: number; files: number }> {
  const sourceExists = unwrap(await source.exists(sourceRoot, context), "Inspect the current workspace");
  if (sourceExists) {
    const info = unwrap(await source.fileInfo(sourceRoot, context), "Inspect the current workspace");
    if (info.kind !== "directory") throw new Error("The current workspace is not a directory");
  }

  const stage = `${destinationRoot}.pidroid-copy-${randomUUID()}`;
  const backup = `${destinationRoot}.pidroid-previous-${randomUUID()}`;
  let bytes = 0;
  let files = 0;
  let stageExists = false;
  let previousMoved = false;
  let installed = false;

  const copyDirectory = async (from: string, to: string): Promise<void> => {
    const entries = unwrap(await source.listDir(from, context), `Read ${from}`);
    for (const entry of entries) {
      if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/]/.test(entry.name)) {
        throw new Error(`Cannot copy workspace entry with an unsafe name: ${JSON.stringify(entry.name)}`);
      }
      if (entry.kind === "symlink") {
        throw new Error(`Cannot copy workspace: symbolic links are not supported (${entry.path})`);
      }
      const target = unwrap(await destination.joinPath([to, entry.name], context), `Resolve ${entry.name}`);
      if (entry.kind === "directory") {
        unwrap(await destination.createDir(target, { recursive: true }, context), `Create ${target}`);
        await copyDirectory(entry.path, target);
        continue;
      }

      if (entry.size > WORKSPACE_COPY_LIMIT_BYTES - bytes) {
        throw new Error(`Workspace copy exceeds the ${Math.round(WORKSPACE_COPY_LIMIT_BYTES / 1048576)} MiB transfer limit`);
      }
      const content = unwrap(await source.readBinaryFile(entry.path, context), `Read ${entry.path}`);
      if (content.byteLength > WORKSPACE_COPY_LIMIT_BYTES - bytes) {
        throw new Error(`Workspace copy exceeds the ${Math.round(WORKSPACE_COPY_LIMIT_BYTES / 1048576)} MiB transfer limit`);
      }
      unwrap(await destination.writeFile(target, content, context), `Write ${target}`);
      bytes += content.byteLength;
      files++;
    }
  };

  try {
    unwrap(await destination.createDir(stage, { recursive: true }, context), "Prepare the destination workspace");
    stageExists = true;
    if (sourceExists) await copyDirectory(sourceRoot, stage);

    const destinationExists = unwrap(await destination.exists(destinationRoot, context), "Inspect the destination workspace");
    if (destinationExists) {
      const info: FileInfo = unwrap(await destination.fileInfo(destinationRoot, context), "Inspect the destination workspace");
      if (info.kind !== "directory") throw new Error("The destination workspace is not a directory");
      unwrap(await destination.renameFile(destinationRoot, backup, context), "Preserve the destination workspace");
      previousMoved = true;
    }

    try {
      unwrap(await destination.renameFile(stage, destinationRoot, context), "Install the copied workspace");
      stageExists = false;
      installed = true;
    } catch (error) {
      if (previousMoved) {
        const restored = await destination.renameFile(backup, destinationRoot, context);
        if (restored.ok) previousMoved = false;
        else throw new Error(`${message(error)}; the previous workspace remains at ${backup} because it could not be restored`);
      }
      throw error;
    }

    if (previousMoved) {
      // A cleanup failure is not a failed copy: the new workspace is already installed, and the backup is preserved.
      const removed = await destination.remove(backup, { recursive: true, force: true }, context);
      if (!removed.ok) console.warn(`[pidroid] copied workspace but could not remove its backup ${backup}: ${removed.error.message}`);
      previousMoved = false;
    }

    return { bytes, files };
  } catch (error) {
    if (stageExists) await destination.remove(stage, { recursive: true, force: true }, context).catch(() => undefined);
    if (previousMoved && !installed) {
      const restored = await destination.renameFile(backup, destinationRoot, context);
      if (!restored.ok) {
        throw new Error(`${message(error)}; the previous workspace remains at ${backup} because it could not be restored`);
      }
    }
    throw error;
  }
}
