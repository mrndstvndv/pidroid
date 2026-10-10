/**
 * Runtime probe: evaluate code inside the running Bun process and get the result back.
 *
 * Why this exists: `bash` spawns a child process, so it cannot reach the live server. This runs
 * in-process, which makes it the right tool for "what does the runtime actually do?" questions:
 * feature-detecting an API, reading a version, checking what an object really contains.
 *
 * Scope, precisely: this reaches the process and the platform — `Bun.*`, `process.*`, memory,
 * uptime, the server's own HTTP endpoints, console output. It does NOT reach the application:
 * server.ts locals (harness, registry, db, latestView) and other extensions' internals are
 * module-scoped and invisible from here — verified, nothing on globalThis matches them. Exposing
 * them would need a deliberate debug handle in server.ts, not this tool.
 *
 * Two deliberate restrictions:
 *   - Local server modules (./server.ts and friends) are refused by default. They have top-level
 *     side effects — Bun.serve, Harness.open, sqlite writes — so importing one from here would
 *     start a second server on the same port and kill the session. Opt in per call if you know why.
 *   - console.* is captured and returned instead of written to logcat, so probe output arrives as
 *     tool output. It is restored in a finally block even if the code throws.
 *
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** Server modules whose import would start a second server or corrupt state. */
const LOCAL_MODULES = [
  "server",
  "chatview",
  "sessions",
  "auth",
  "extensions",
  "providers/commandcode",
  "providers/opencode",
];

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

function clip(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** Reject imports of app modules before anything runs. */
function findLocalImport(code: string): string | undefined {
  const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;
  for (const match of code.matchAll(pattern)) {
    const spec = match[1].replace(/^\.\//, "").replace(/\.(ts|js|mjs)$/, "");
    if (LOCAL_MODULES.includes(spec)) return spec;
  }
  return undefined;
}

/**
 * Build a function from source. A single expression is returned implicitly; anything else
 * is treated as a statement body where `return` works as usual. `await` is allowed in both.
 */
function compile(code: string): () => unknown {
  try {
    return new Function(`return (async () => (${code}\n))();`) as () => unknown;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return new Function(`return (async () => {\n${code}\n})();`) as () => unknown;
  }
}

/** JSON-safe view of a value: cycles, depth and huge arrays all collapse instead of throwing. */
function describe(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const type = typeof value;
  if (type === "string") return value.length > 2000 ? `${(value as string).slice(0, 2000)}… (${(value as string).length} chars)` : value;
  if (type === "number" || type === "boolean" || type === "bigint") return `${value.toString()}${type === "bigint" ? "n" : ""}`;
  if (type === "function") return `[function ${(value as { name?: string }).name || "anonymous"}]`;
  if (type === "symbol") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 4).join("\n") };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (depth > 4) return "[deep]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((v) => describe(v, depth + 1, seen));
    if (value.length > 100) items.push(`… ${value.length - 100} more`);
    return items;
  }
  if (value instanceof Map) return { __map: [...value.entries()].slice(0, 50).map(([k, v]) => [describe(k, depth + 1, seen), describe(v, depth + 1, seen)]) };
  if (value instanceof Set) return { __set: [...value].slice(0, 50).map((v) => describe(v, depth + 1, seen)) };
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${(value as { constructor: { name: string } }).constructor.name} ${(value as ArrayBufferView).byteLength ?? 0} bytes]`;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).slice(0, 100)) {
    try {
      out[key] = describe((value as Record<string, unknown>)[key], depth + 1, seen);
    } catch (err) {
      out[key] = `[unreadable: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  const keys = Object.keys(value as object);
  if (keys.length > 100) out.__truncated = `${keys.length - 100} more keys`;
  return out;
}

/** Capture console output for the duration of `fn`, always restoring the originals. */
async function withCapturedConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);

  const record = (level: string) => (...args: unknown[]) => {
    logs.push(`[${level}] ${args.map((a) => (typeof a === "string" ? a : safeInspect(a))).join(" ")}`);
  };
  for (const method of methods) console[method] = record(method);

  try {
    return { result: await fn(), logs };
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
}

function safeInspect(value: unknown): string {
  try {
    return Bun.inspect(value, { depth: 3, colors: false });
  } catch {
    return String(value);
  }
}

const evalRuntime = defineTool({
  name: "eval_runtime",
  view: { verb: { one: "ran code", many: "ran code {n} times" } },
  description:
    "Evaluate code inside the running Bun process and return its value plus anything it logged. " +
    "Unlike bash this is in-process, so it reaches the runtime itself: the Bun API surface, process state, " +
    "and the server's own HTTP endpoints — use it to check what a runtime actually provides instead of guessing. " +
    "It does not reach the app's internals: server.ts locals (harness, registry, db) are module-scoped and not visible here. " +
    "A single expression is returned implicitly; multiple statements work as a body with `return`. " +
    "await is allowed. console.* output is captured and returned. Importing local server modules " +
    "(server.ts, chatview.ts, ...) is refused unless allowLocalImports is set, because their top-level " +
    "side effects would start a second server on the same port.",
  parameters: Type.Object({
    code: Type.String({ description: "JavaScript/TypeScript to evaluate" }),
    timeoutMs: Type.Optional(Type.Number({ description: `Abort after this many ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` })),
    allowLocalImports: Type.Optional(Type.Boolean({ description: "Permit importing ./server.ts and other app modules. Off by default: they start a second server." })),
  }),
  execute: async (args, api) => {
    const code = String(args.code ?? "").trim();
    if (!code) return {};

    const localImport = findLocalImport(code);
    if (localImport && !args.allowLocalImports) {
      throw new Error(
        `Refusing to import "${localImport}": app modules have top-level side effects (Bun.serve, Harness.open, sqlite writes) ` +
          `and importing one here would start a second server on port ${Number(process.env.PORT) || 8765}. ` +
          `Pass allowLocalImports: true if you understand the risk and want to do it anyway.`,
      );
    }

    const limit = Math.min(Math.max(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let compiled: () => unknown;
    try {
      compiled = compile(code);
    } catch (err) {
      throw new Error(`Could not compile: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Note: a synchronous infinite loop cannot be interrupted by a timer, so the timeout
    // only bounds async work. Such a probe would hang the server until it is restarted.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${limit}ms`)), limit);
    });

    const started = Date.now();
    try {
      const { result, logs } = await withCapturedConsole(async () => {
        const work = (async () => {
          const value = await compiled();
          return value === undefined ? undefined : describe(value);
        })();
        return await Promise.race([work, timeout]);
      });

      const took = Date.now() - started;
      const parts: string[] = [];
      if (logs.length) parts.push(logs.join("\n"));
      parts.push(result === undefined ? `→ undefined (${took}ms)` : `→ ${JSON.stringify(result, null, 2)}${took > 50 ? `  [${took}ms]` : ""}`);
      api.output(clip(parts.join("\n")));
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {};
  },
});

export default defineExtension({
  name: "runtime-probe",
  tools: [evalRuntime],
});
