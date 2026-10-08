/**
 * Syntax highlighting for the Files preview and the Changes-tab diff.
 *
 * Two decisions shape this file, both measured on this phone rather than assumed:
 *
 *  - The Oniguruma (wasm) engine, not @shikijs/engine-javascript. Both walk the same TextMate
 *    grammars, but the JS engine compiles them through oniguruma-to-es, and on the TypeScript
 *    grammar that is pathological: ~2.4s for six lines cold, ~450ms warm. The wasm engine does
 *    the same work in ~330ms cold and ~11ms warm, for 608 KB instead of 12 KB. That is the right
 *    trade here because we highlight a file the user is looking at *right now*; bulk throughput
 *    over a 340 KB file is within 25% of the JS engine either way.
 *
 *  - The theme is an inline object, not a @shikijs/themes package. That costs zero vendor bytes
 *    and lets the palette be true AMOLED black instead of a theme's idea of dark grey.
 *
 * Grammars are separate vendor bundles, so a language is loaded by dynamic import the first time
 * a file of that type is opened and then kept for the process. Languages we do not ship, and
 * languages nobody opens, cost nothing at runtime.
 *
 * Every entry point degrades to null rather than throwing: highlighting is decoration, and a
 * grammar that fails to load must never stop someone reading their own source.
 */

import { createHighlighterCore, type ThemeRegistration } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
// The named loader, not the module's default export: the vendor bundles are built with
// `export * from`, which keeps named exports but drops `default`. `getWasmInstance` is the same
// function the default export is, so nothing is lost and build-vendor.ts needs no special case.
import { getWasmInstance } from "@shikijs/engine-oniguruma/wasm-inlined";

/** One styled line: its number, its plain text, and its coloured HTML. */
export interface HighlightLine {
  /** 1-based. */
  n: number;
  /** Plain text, for copy and for the diff paths that want text and not markup. */
  text: string;
  /** Coloured spans. Already escaped. */
  html: string;
}

export interface HighlightResult {
  lang: string;
  lines: HighlightLine[];
}

/** Above this, skip highlighting: the JSON payload stops being worth the parse on a phone. */
const MAX_HIGHLIGHT_BYTES = 600_000;

/**
 * Compact data -- a minified bundle, a single-line JSON blob -- is not worth tokenising. There are
 * almost no lines to fold, so the whole file's markup has to cross the wire: pidroid-models.json is
 * one line per record and a one-line edit there produced 1.2 MB of JSON for 5 rows. Long lines are
 * also where a TextMate grammar does its worst work relative to what you can read on a phone.
 */
function isCompact(code: string): boolean {
  let lines = 1;
  let longest = 0;
  let at = 0;
  for (let i = 0; i <= code.length; i++) {
    if (i === code.length || code.charCodeAt(i) === 10) {
      const len = i - at;
      if (len > longest) longest = len;
      if (len > 4000) return true;
      lines++;
      at = i + 1;
    }
  }
  return lines < 6 && code.length > 16_000;
}

/**
 * File extension -> Shiki language. `.js` and friends map to typescript on purpose: Shiki's
 * javascript grammar is a re-export of the TypeScript one, so it is the same 177 KB either way
 * and the javascript grammar file itself is 0.1 KB of indirection.
 */
const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "typescript", mjs: "typescript", cjs: "typescript", jsx: "typescript",
  json: "json", jsonc: "json",
  html: "html", htm: "html",
  css: "css",
  md: "markdown", markdown: "markdown",
  yaml: "yaml", yml: "yaml",
  py: "python",
  sh: "shell", bash: "shell", zsh: "shell",
  patch: "diff", diff: "diff",
  // Markdown fences often name the language rather than its extension.
  typescript: "typescript", javascript: "typescript", tsx: "typescript",
  python: "python", shell: "shell",
};

/** Filename -> language, for the extensionless cases that actually matter. */
const BY_NAME: Record<string, string> = {
  dockerfile: "shell",
  makefile: "shell",
};

/** The grammar bundles we ship, as literal loaders. The specifiers have to be literals: Bun applies
 *  tsconfig `paths` when it sees a static specifier, but a computed `import(someVariable)` goes to
 *  the plain resolver, which knows nothing about our vendored paths. */
const GRAMMAR_LOADERS: Record<string, () => Promise<{ default?: unknown }>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  json: () => import("@shikijs/langs/json"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  python: () => import("@shikijs/langs/python"),
  diff: () => import("@shikijs/langs/diff"),
  shell: () => import("@shikijs/langs/shell"),
};

/**
 * Black on black. GitHub Dark's token hues -- they survive a true #000 background well -- over a
 * black canvas, so highlighted code does not sit on a grey slab inside an OLED-black UI.
 */
const THEME: ThemeRegistration = {
  name: "pidroid-black",
  type: "dark",
  colors: { "editor.background": "#000000", "editor.foreground": "#c9d1d9" },
  settings: [
    { settings: { background: "#000000", foreground: "#c9d1d9" } },
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: "#5c6370", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.control", "keyword.operator"], settings: { foreground: "#ff7b72" } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "#a5d6ff" } },
    { scope: ["constant", "constant.numeric", "constant.language", "variable.language"], settings: { foreground: "#79c0ff" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#d2a8ff" } },
    { scope: ["entity.name.type", "support.type", "support.class", "entity.name.class"], settings: { foreground: "#7ee787" } },
    { scope: ["variable", "variable.parameter", "meta.object-literal.key"], settings: { foreground: "#ffa657" } },
    { scope: ["entity.name.tag", "meta.tag"], settings: { foreground: "#7ee787" } },
    { scope: ["entity.other.attribute-name", "support.type.property-name"], settings: { foreground: "#ffa657" } },
    { scope: ["punctuation", "meta.brace", "meta.delimiter"], settings: { foreground: "#8b949e" } },
    { scope: ["keyword.operator", "punctuation.separator", "punctuation.accessor"], settings: { foreground: "#ff7b72" } },
    { scope: ["constant.character.escape", "string.regexp", "string.other.link"], settings: { foreground: "#a5d6ff" } },
    { scope: ["markup.heading", "markup.bold", "markup.italic"], settings: { foreground: "#d2a8ff", fontStyle: "bold" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#a5d6ff" } },
    { scope: ["markup.inserted"], settings: { foreground: "#7ee787" } },
    { scope: ["markup.deleted", "markup.changed"], settings: { foreground: "#ff7b72" } },
  ],
};

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;
interface Token {
  content: string;
  color?: string;
  /** TextMate style bitmask: 1 italic, 2 bold, 4 underline. Older shapes pass a string. */
  fontStyle?: number | string;
}

/** Language -> highlighter, holding that language's grammar for the life of the process. */
const highlighters = new Map<string, Promise<Highlighter>>();
/** The wasm engine is expensive to build and shared by every language, so build it once. */
const enginePromise = createOnigurumaEngine(getWasmInstance).catch((err) => {
  console.error(`[highlight] wasm engine unavailable: ${err}`);
  return null;
});
/** code -> tokens, per highlighter. `codeToTokens` is synchronous once a highlighter exists, so
 *  the only asynchronous part of `highlight()` is loading a grammar the first time. */
const tokenCaches = new WeakMap<Highlighter, Map<string, Token[][]>>();

/** Escape for the HTML we assemble. Shiki escapes inside `codeToHtml`; we are not using that. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The Shiki language for a path, or null when we ship no grammar for it. */
export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const named = BY_NAME[base.toLowerCase()];
  if (named) return named;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

function highlighterFor(lang: string): Promise<Highlighter> {
  const existing = highlighters.get(lang);
  if (existing) return existing;
  const load = GRAMMAR_LOADERS[lang];
  if (!load) return Promise.reject(new Error(`no grammar shipped for ${lang}`));
  const pending = (async () => {
    const engine = await enginePromise;
    if (!engine) throw new Error("oniguruma engine unavailable");
    // Grammar modules default-export their registration list (the vendor build keeps that default).
    const mod = await load();
    const registrations = mod.default ?? mod;
    return createHighlighterCore({ themes: [THEME], langs: Array.isArray(registrations) ? registrations : [registrations], engine });
  })();
  highlighters.set(lang, pending);
  // A grammar that fails must not poison the cache, or that language is dead for the session.
  pending.catch(() => highlighters.delete(lang));
  return pending;
}

/** Turn a TextMate fontStyle (a bitmask: 1 italic, 2 bold, 4 underline) into a CSS declaration. */
function fontStyleCss(fontStyle: number | string | undefined): string {
  if (!fontStyle) return "";
  if (typeof fontStyle === "string") {
    // Some shapes hand back "italic" / "bold" directly.
    return fontStyle.includes("italic") ? "font-style:italic;" : fontStyle.includes("bold") ? "font-weight:600;" : "";
  }
  let css = "";
  if (fontStyle & 1) css += "font-style:italic;";
  if (fontStyle & 2) css += "font-weight:600;";
  if (fontStyle & 4) css += "text-decoration:underline;";
  return css;
}

function toLines(tokens: Token[][]): HighlightLine[] {
  const lines: HighlightLine[] = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const row = tokens[i];
    let text = "";
    let html = "";
    for (const token of row) {
      text += token.content;
      // fontStyle is part of the theme, not decoration we can drop: comments and bold list items
      // are the only places it shows, and losing it makes italic comments render as plain grey.
      const style = `${token.color ? `color:${token.color};` : ""}${fontStyleCss(token.fontStyle)}`;
      html += style ? `<span style="${style}">${esc(token.content)}</span>` : esc(token.content);
    }
    lines[i] = { n: i + 1, text, html };
  }
  return lines;
}

/**
 * Highlight `code` as `lang`, loading the grammar on first use. Returns null when the language is
 * not shipped, the input is too large, or anything at all goes wrong -- callers fall back to
 * plain escaped text, which is exactly what they did before highlighting existed.
 */
export async function highlight(code: string, lang: string): Promise<HighlightResult | null> {
  if (code.length > MAX_HIGHLIGHT_BYTES || isCompact(code)) return null;
  let hl: Highlighter;
  try {
    hl = await highlighterFor(lang);
  } catch (err) {
    console.error(`[highlight] ${lang} unavailable: ${err}`);
    return null;
  }
  let cache = tokenCaches.get(hl);
  if (!cache) tokenCaches.set(hl, (cache = new Map()));
  let tokens = cache.get(code);
  if (!tokens) {
    try {
      tokens = hl.codeToTokens(code, { lang, theme: THEME.name }).tokens as Token[][];
    } catch {
      return null;
    }
    // Do not let a one-shot huge file pin its tokens for the life of the process.
    if (cache.size > 64) cache.clear();
    cache.set(code, tokens);
  }
  return { lang, lines: toLines(tokens) };
}

/** Work out the language from a path and highlight in one call. Always returns a promise, even
 *  when there is no grammar: callers chain onto this, and a bare `null` here would break them on
 *  exactly the files that have nothing to highlight. */
export async function highlightPath(code: string, path: string): Promise<HighlightResult | null> {
  const lang = languageFor(path);
  return lang ? highlight(code, lang) : null;
}

/**
 * Load the grammars most likely to be hit, off the request path, so the first file preview does
 * not pay the wasm compile. Fire-and-forget; failures are ignored on purpose.
 */
export function warm(): void {
  for (const lang of ["typescript", "json", "markdown"]) highlighterFor(lang).catch(() => {});
}