/**
 * How the chat view presents calls to a tool. Extensions declare one on a tool (`defineTool({ name, view })`) or
 * for a tool they do not own (`defineExtension({ views: { name: view } })`); the tool's own `view` wins. It is a
 * plain data description, not a function: the chat view runs in the page, and a closure cannot cross the wire. Every
 * field is optional and anything the view does not recognise falls back to the generic rendering, so a view can only
 * ever make a tool read better, never hide it.
 */
export interface ToolView {
  /** lucide icon name for the row, instead of the substring guess in toolIcon(). */
  icon?: string;
  /** Argument shown on the collapsed row, instead of command/path/file_path/the first value. */
  summaryArg?: string;
  /** Whether the row starts expanded. */
  open?: boolean;
  /** What the expanded body shows: "json" (arguments), "command" (args.command), "output" (the result text),
   *  "diff" (unified diff of args.edits), "file" (args.content, clipped), "cards" (web-search result cards)
   *  or "plot" (a curve, from a {"plot":...} payload the tool left in its output). */
  body?: ToolViewBody;
  /** Label above the body, when the default one ("arguments") is wrong. */
  label?: string;
  /** Leave the result text out of the body, for a tool whose preview already says everything. */
  hideOutput?: boolean;
}

export type ToolViewBody = "json" | "command" | "output" | "diff" | "file" | "cards" | "plot";

const VIEW_BODIES: ToolViewBody[] = ["json", "command", "output", "diff", "file", "cards", "plot"];

/** The view as it will be sent to the page: known keys only, right types, nothing that could fail to serialise. */
function cleanView(view: unknown): ToolView | undefined {
  if (!view || typeof view !== "object") return undefined;
  const v = view as Record<string, unknown>;
  const out: ToolView = {};
  if (typeof v.icon === "string" && v.icon) out.icon = v.icon.slice(0, 40);
  if (typeof v.summaryArg === "string" && v.summaryArg) out.summaryArg = v.summaryArg.slice(0, 40);
  if (typeof v.open === "boolean") out.open = v.open;
  if (typeof v.label === "string" && v.label) out.label = v.label.slice(0, 40);
  if (typeof v.hideOutput === "boolean") out.hideOutput = v.hideOutput;
  // An unknown body kind is dropped rather than passed on, so the page keeps its own default.
  if (VIEW_BODIES.includes(v.body as ToolViewBody)) out.body = v.body as ToolViewBody;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Hot-swappable extensions. Every extensions/*.ts file default-exports a pi-durable extension
 * (`defineExtension({ name, tools, sections, hooks, wraps, views })`). reload() re-imports each file with a cache-busting
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

  /**
   * Tool name -> how to present it, from every installed extension. The registry keeps the extension object as
   * authored, so `view` written next to a defineTool survives install() and can be read back here. Later
   * extensions win over earlier ones, and a tool's own `view` over the extension-level `views` map.
   */
  views(): Record<string, ToolView> {
    // Stable identity until an extension is installed or removed, so callers can tell cheaply
    // whether it changed (the chat view asks on every streaming update).
    return (this.#views ??= this.#collectViews());
  }
  #views: Record<string, ToolView> | undefined;

  #collectViews(): Record<string, ToolView> {
    const out: Record<string, ToolView> = {};
    for (const extension of this.installed.values()) {
      const source = extension as Installable & { views?: Record<string, unknown>; tools?: { name?: string; view?: unknown }[] };
      for (const [name, view] of Object.entries(source.views ?? {})) {
        const clean = cleanView(view);
        if (typeof name === "string" && clean) out[name] = clean;
      }
      for (const tool of source.tools ?? []) {
        const clean = cleanView(tool?.view);
        if (tool?.name && clean) out[tool.name] = clean;
      }
    }
    return out;
  }

  async reload(): Promise<ReloadResult> {
    const result: ReloadResult = { loaded: [], removed: [], skipped: [], errors: {} };
    const files = existsSync(this.dir)
      ? readdirSync(this.dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.startsWith("_"))
      : [];
    const active = files.filter((file) => this.isEnabled(file));

    // Import everything at once (the files are independent and each pulls in its own dependencies),
    // then install in directory order, since a later extension wins over an earlier one.
    const stamp = Date.now();
    // A plain path + query re-imports the file; Bun caches file:// URLs regardless of the query.
    const imports = active.map((file) => import(`${join(this.dir, file)}?v=${stamp}`).then((m) => ({ ok: true as const, m }), (error) => ({ ok: false as const, error })));
    const imported = await Promise.all(imports);

    for (const [i, file] of active.entries()) {
      try {
        const got = imported[i];
        if (!got.ok) throw got.error;
        const extension = got.m.default as Installable | undefined;
        if (!extension || typeof extension.name !== "string") throw new Error("default export must be defineExtension({ name, ... })");
        const previous = this.installed.get(file);
        if (previous && previous.name !== extension.name) this.registry.uninstall(previous); // renamed inside the file
        this.registry.install(extension);
        this.installed.set(file, extension);
        this.#views = undefined;
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
      this.#views = undefined;
      (files.includes(file) ? result.skipped : result.removed).push(`${file} (${extension.name})`);
    }
    return result;
  }
}
