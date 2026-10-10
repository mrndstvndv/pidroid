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
   *  "diff" (unified diff of args.edits), "file" (args.content, clipped), "cards" (web-search result cards), or
   *  "artifact" (the {"artifact":{...}} line at the end of the result, drawn as a card by www/artifact.js). */
  body?: ToolViewBody;
  /** Label above the body, when the default one ("arguments") is wrong. */
  label?: string;
  /** Leave the result text out of the body, for a tool whose preview already says everything. */
  hideOutput?: boolean;
  /** Keep the call out of the collapsed run of working a stretch of tool calls folds into, and render it on
   *  its own in the open. For the things the reader is meant to look at rather than the steps towards the
   *  answer: an artifact, say, whose card would otherwise be buried under "used 3 tools". */
  standalone?: boolean;
  /** How calls are counted on the folded line a run of tool calls collapses into ("Ran 3 commands,
   *  read a file"): `one` for a single call, `many` with {n} for the count, both lower case, e.g.
   *  { one: "checked the battery", many: "checked the battery {n} times" }. Without one, the
   *  tool's calls are counted as "used N tools". */
  verb?: { one: string; many: string };
}

export type ToolViewBody = "json" | "command" | "output" | "diff" | "file" | "cards" | "artifact";

const VIEW_BODIES: ToolViewBody[] = ["json", "command", "output", "diff", "file", "cards", "artifact"];

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
  if (typeof v.standalone === "boolean") out.standalone = v.standalone;
  const verb = v.verb as { one?: unknown; many?: unknown } | undefined;
  if (verb && typeof verb.one === "string" && verb.one && typeof verb.many === "string" && verb.many) {
    out.verb = { one: verb.one.slice(0, 60), many: verb.many.slice(0, 60) };
  }
  // An unknown body kind is dropped rather than passed on, so the page keeps its own default.
  if (VIEW_BODIES.includes(v.body as ToolViewBody)) out.body = v.body as ToolViewBody;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Hot-swappable extensions. Every extension file default-exports a pi-durable extension
 * (`defineExtension({ name, tools, sections, hooks, wraps, views })`). Two directories are loaded, in order:
 * the built-in ones shipped with the app (APP_DIR/extensions, read-only), then the user's own
 * (DATA_DIR/extensions, written by the agent). A later extension of the same name replaces an earlier one.
 *
 * reload() re-imports each file with a cache-busting query (a plain path, since Bun caches file:// URLs) and
 * installs it: pi-durable replaces an installed extension of the same name in place, so work that is already
 * running finishes on the old code and the next request, tool call or prompt uses the new one. No restart, and
 * sessions keep going. Files an extension imports itself (./helper.ts) are cached, so keep extensions
 * self-contained. A file that fails to import leaves the previous version of its extension installed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Installable {
  readonly name: string;
}

interface RegistryLike {
  install(extension: any): void;
  uninstall(extension: any): void;
}

export type ExtensionOrigin = "builtin" | "user";

/** A directory of extension files, and whether the app ships it (builtin) or the agent writes it (user). */
export interface ExtensionSource {
  origin: ExtensionOrigin;
  dir: string;
}

/**
 * A file on disk. `key` is "<origin>:<file>" (e.g. "builtin:android.ts", "user:weather.ts"): it is what the
 * settings toggle stores, so a built-in and a user file with the same name are told apart.
 */
interface ExtensionEntry {
  key: string;
  origin: ExtensionOrigin;
  file: string;
  path: string;
}

export interface ReloadResult {
  loaded: string[];
  removed: string[];
  /** switched off in settings, so its extension was uninstalled rather than loaded */
  skipped: string[];
  errors: Record<string, string>;
}

export interface ExtensionState {
  key: string;
  origin: ExtensionOrigin;
  file: string;
  name: string;
  enabled: boolean;
}

const EXTENSION_FILE = /\.(ts|js|mjs)$/;

export class ExtensionLoader {
  /** entry key -> the extension it last installed */
  private installed = new Map<string, Installable>();

  constructor(
    private readonly registry: RegistryLike,
    private readonly sources: ExtensionSource[],
    /** Consulted on every reload, so a toggle takes effect on the next one. Defaults to "everything on". */
    private readonly isEnabled: (key: string) => boolean = () => true,
  ) {
    for (const source of sources) mkdirSync(source.dir, { recursive: true });
  }

  /** Every extension file on disk, in load order: the sources in turn, each one's files by name. */
  private entries(): ExtensionEntry[] {
    return this.sources.flatMap(({ origin, dir }) =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => EXTENSION_FILE.test(f) && !f.startsWith("_"))
            .sort()
            .map((file) => ({ key: `${origin}:${file}`, origin, file, path: join(dir, file) }))
        : [],
    );
  }

  /** Files the loader skips on purpose (a leading underscore), so the settings tab can say why they have no switch. */
  parked(): { origin: ExtensionOrigin; file: string }[] {
    return this.sources.flatMap(({ origin, dir }) =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => EXTENSION_FILE.test(f) && f.startsWith("_"))
            .sort()
            .map((file) => ({ origin, file }))
        : [],
    );
  }

  /** What is on disk, what is loaded, and what settings have switched off -- for the settings tab and the agent. */
  list(): ExtensionState[] {
    return this.entries().map(({ key, origin, file }) => ({
      key,
      origin,
      file,
      name: this.installed.get(key)?.name ?? file.replace(EXTENSION_FILE, ""),
      enabled: this.isEnabled(key),
    }));
  }

  /**
   * Delete a user extension's file. Built-in extensions ship with the app and are refused. The caller reloads
   * afterwards, which uninstalls the extension.
   */
  removeUser(key: string): string {
    const entry = this.entries().find((e) => e.key === key);
    if (!entry || entry.origin !== "user") throw new Error(`${key} is not a user extension; built-in extensions ship with the app and cannot be removed`);
    unlinkSync(entry.path);
    return entry.file;
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
    const all = this.entries();
    const active = all.filter((entry) => this.isEnabled(entry.key));

    // Import everything at once (the files are independent and each pulls in its own dependencies),
    // then install in load order, since a later extension wins over an earlier one.
    const stamp = Date.now();
    // A plain path + query re-imports the file; Bun caches file:// URLs regardless of the query.
    const imports = active.map((entry) => import(`${entry.path}?v=${stamp}`).then((m) => ({ ok: true as const, m }), (error) => ({ ok: false as const, error })));
    const imported = await Promise.all(imports);

    for (const [i, entry] of active.entries()) {
      try {
        const got = imported[i];
        if (!got.ok) throw got.error;
        const extension = got.m.default as Installable | undefined;
        if (!extension || typeof extension.name !== "string") throw new Error("default export must be defineExtension({ name, ... })");
        const previous = this.installed.get(entry.key);
        if (previous && previous.name !== extension.name) this.registry.uninstall(previous); // renamed inside the file
        this.registry.install(extension);
        this.installed.set(entry.key, extension);
        this.#views = undefined;
        result.loaded.push(`${entry.key} (${extension.name})`);
      } catch (err) {
        result.errors[entry.key] = err instanceof Error ? err.message : String(err);
      }
    }

    // A deleted file takes its extension with it, and so does one that was switched off.
    const activeKeys = new Set(active.map((entry) => entry.key));
    const onDisk = new Set(all.map((entry) => entry.key));
    for (const [key, extension] of [...this.installed]) {
      if (activeKeys.has(key)) continue;
      // A user file can share its name with a built-in one and replace it. Uninstalling by name would then take the
      // built-in down too, so the registry is left alone while another installed file still provides that name.
      const shadowed = [...this.installed].some(([other, ext]) => other !== key && ext.name === extension.name);
      if (!shadowed) this.registry.uninstall(extension);
      this.installed.delete(key);
      this.#views = undefined;
      (onDisk.has(key) ? result.skipped : result.removed).push(`${key} (${extension.name})`);
    }
    return result;
  }
}

/**
 * Write DATA_DIR/extensions/tsconfig.json, so a user extension can import the same packages the app's own code
 * can. Bun resolves imports through the tsconfig nearest the importing file, and that directory is not beside the
 * app, so the app's `paths` are copied with every target made absolute under the app directory. Regenerated on
 * every boot: an update can change the vendor files (and so the targets). Failure is logged, not fatal.
 */
export function writeExtensionsTsconfig(appDir: string, dir: string): void {
  try {
    const source = JSON.parse(readFileSync(join(appDir, "tsconfig.json"), "utf8"));
    const options = source?.compilerOptions ?? {};
    const baseUrl = resolve(appDir, options.baseUrl ?? ".");
    const paths: Record<string, string[]> = {};
    for (const [specifier, targets] of Object.entries<unknown>(options.paths ?? {})) {
      paths[specifier] = (Array.isArray(targets) ? targets : [targets]).map((target) => resolve(baseUrl, String(target)));
    }
    const compilerOptions = {
      baseUrl,
      paths,
      module: options.module,
      target: options.target,
      moduleResolution: options.moduleResolution,
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions }, null, 2) + "\n");
  } catch (err) {
    console.warn(`[pidroid] could not write ${join(dir, "tsconfig.json")}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
