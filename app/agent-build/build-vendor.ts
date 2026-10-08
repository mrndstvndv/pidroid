/**
 * Build step (run by Gradle's bundleAgent, not on the phone): bundles the npm dependencies the agent's source
 * imports into a few split ESM files under <out>/vendor, and writes a tsconfig.json whose `paths` point each
 * package specifier at its vendor file. The phone then runs server.ts and extensions straight from source with no
 * node_modules, and because the entries are built together with code splitting, shared modules (pi-ai, chord, ...)
 * exist exactly once, so everything the agent writes imports the same instances the server uses.
 *
 * pi-env deploys a prebuilt daemon found at `<package root>/bin/<platform>/pi-env`, where its package root is resolved
 * from `import.meta.url`. In the bundle that resolves to <out>, so the package's bin/ is copied to <out>/bin.
 *
 * Usage: bun build-vendor.ts <outDir>
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** package specifier -> vendor file name. Extend this to give the agent more packages. */
const VENDOR: Record<string, string> = {
  "@earendil-works/pi-durable": "pi-durable",
  "@earendil-works/pi-durable/env/node": "pi-durable-env-node",
  "@earendil-works/pi-durable/storage/sqlite/node": "pi-durable-storage-sqlite-node",
  "@earendil-works/pi-durable/tools": "pi-durable-tools",
  "@earendil-works/pi-env": "pi-env",
  "@earendil-works/pi-ai": "pi-ai",
  "@earendil-works/pi-ai/providers/all": "pi-ai-providers-all",
  "@earendil-works/pi-ai/api/anthropic-messages.lazy": "pi-ai-api-anthropic-messages",
  "@earendil-works/pi-ai/api/openai-completions.lazy": "pi-ai-api-openai-completions",
  "@earendil-works/pi-ai/api/openai-responses.lazy": "pi-ai-api-openai-responses",
  "@earendil-works/chord": "chord",
  "@earendil-works/chord/context": "chord-context",
  "isomorphic-git": "isomorphic-git",
  diff: "diff",
  // Syntax highlighting (highlight.ts): the Oniguruma wasm engine, inlined, and one grammar per language.
  "@shikijs/core": "shiki-core",
  "@shikijs/engine-oniguruma": "shiki-engine-oniguruma",
  "@shikijs/engine-oniguruma/wasm-inlined": "shiki-engine-oniguruma-wasm",
  "@shikijs/langs/typescript": "shiki-lang-typescript",
  "@shikijs/langs/javascript": "shiki-lang-javascript",
  "@shikijs/langs/json": "shiki-lang-json",
  "@shikijs/langs/html": "shiki-lang-html",
  "@shikijs/langs/css": "shiki-lang-css",
  "@shikijs/langs/markdown": "shiki-lang-markdown",
  "@shikijs/langs/yaml": "shiki-lang-yaml",
  "@shikijs/langs/python": "shiki-lang-python",
  "@shikijs/langs/diff": "shiki-lang-diff",
  "@shikijs/langs/shell": "shiki-lang-shell",
};

const outDir = resolve(process.argv[2] ?? "dist");
const entryDir = resolve(".vendor-entries");
rmSync(entryDir, { recursive: true, force: true });
mkdirSync(entryDir, { recursive: true });
rmSync(join(outDir, "vendor"), { recursive: true, force: true });

const entrypoints: string[] = [];
for (const [specifier, name] of Object.entries(VENDOR)) {
  const file = join(entryDir, `${name}.ts`);
  // A grammar's default export is its registration list; `export *` alone would drop it.
  const hasDefault = specifier === "isomorphic-git" || specifier.startsWith("@shikijs/langs/");
  writeFileSync(file, `export * from "${specifier}";\n${hasDefault ? `export { default } from "${specifier}";\n` : ""}`);
  entrypoints.push(file);
}

const result = await Bun.build({
  entrypoints,
  outdir: join(outDir, "vendor"),
  target: "bun",
  format: "esm",
  splitting: true,
  naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const paths = Object.fromEntries(Object.entries(VENDOR).map(([specifier, name]) => [specifier, [`./vendor/${name}.js`]]));
writeFileSync(
  join(outDir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { baseUrl: ".", paths, module: "esnext", target: "esnext", moduleResolution: "bundler" } }, null, 2) + "\n",
);
rmSync(entryDir, { recursive: true, force: true });
rmSync(join(outDir, "bin"), { recursive: true, force: true });
cpSync(resolve("node_modules/@earendil-works/pi-env/bin"), join(outDir, "bin"), { recursive: true });
console.log(`vendor: ${result.outputs.length} files -> ${join(outDir, "vendor")}`);
