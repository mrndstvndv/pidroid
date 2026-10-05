/**
 * Hot-swappable extensions. Every extensions/*.ts file default-exports a pi-durable extension
 * (`defineExtension({ name, tools, sections, hooks, wraps })`). reload() re-imports each file with a cache-busting
 * query (a plain path, since Bun caches file:// URLs) and installs it: pi-durable replaces an installed extension of the same name in place, so work that is
 * already running finishes on the old code and the next request, tool call or prompt uses the new one. No restart,
 * and sessions keep going. Files an extension imports itself (./helper.ts) are cached, so keep extensions
 * self-contained or restart_server after changing a helper. A file that fails to import leaves the previous version of its extension installed.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Installable {
  readonly name: string;
}

interface RegistryLike {
  install(extension: any): void;
  uninstall(extension: any): void;
}

export interface ReloadResult {
  loaded: string[];
  removed: string[];
  /** switched off in settings, so its extension was uninstalled rather than loaded */
  skipped: string[];
  errors: Record<string, string>;
}

export interface ExtensionState {
  file: string;
  name: string;
  enabled: boolean;
}

export class ExtensionLoader {
  /** file name -> the extension it last installed */
  private installed = new Map<string, Installable>();

  constructor(
    private readonly registry: RegistryLike,
    private readonly dir: string,
    /** Consulted on every reload, so a toggle takes effect on the next one. Defaults to "everything on". */
    private readonly isEnabled: (file: string) => boolean = () => true,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** What is on disk, what is loaded, and what settings have switched off -- for the settings tab. */
  list(): ExtensionState[] {
    const files = existsSync(this.dir)
      ? readdirSync(this.dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.startsWith("_"))
      : [];
    return files.map((file) => ({
      file,
      name: this.installed.get(file)?.name ?? file.replace(/\.(ts|js|mjs)$/, ""),
      enabled: this.isEnabled(file),
    }));
  }

  async reload(): Promise<ReloadResult> {
    const result: ReloadResult = { loaded: [], removed: [], skipped: [], errors: {} };
    const files = existsSync(this.dir)
      ? readdirSync(this.dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.startsWith("_"))
      : [];
    const active = files.filter((file) => this.isEnabled(file));

    for (const file of active) {
      try {
        // A plain path + query re-imports the file; Bun caches file:// URLs regardless of the query.
        const extension = (await import(`${join(this.dir, file)}?v=${Date.now()}`)).default as Installable | undefined;
        if (!extension || typeof extension.name !== "string") throw new Error("default export must be defineExtension({ name, ... })");
        const previous = this.installed.get(file);
        if (previous && previous.name !== extension.name) this.registry.uninstall(previous); // renamed inside the file
        this.registry.install(extension);
        this.installed.set(file, extension);
        result.loaded.push(`${file} (${extension.name})`);
      } catch (err) {
        result.errors[file] = err instanceof Error ? err.message : String(err);
      }
    }

    // A deleted file takes its extension with it, and so does one that was switched off.
    for (const [file, extension] of [...this.installed]) {
      if (active.includes(file)) continue;
      this.registry.uninstall(extension);
      this.installed.delete(file);
      (files.includes(file) ? result.skipped : result.removed).push(`${file} (${extension.name})`);
    }
    return result;
  }
}
