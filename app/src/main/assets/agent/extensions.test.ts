import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionLoader, writeExtensionsTsconfig } from "./extensions.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pidroid-ext-"));
  const builtin = join(root, "app", "extensions");
  const user = join(root, "data", "extensions");
  mkdirSync(builtin, { recursive: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(join(builtin, "android.ts"), `export default { name: "android" };`);
  writeFileSync(join(builtin, "_example.ts"), `export default { name: "parked" };`);
  writeFileSync(join(user, "weather.ts"), `export default { name: "weather" };`);
  const installed = new Map<string, string>();
  const registry = {
    install: (ext: { name: string }) => installed.set(ext.name, ext.name),
    uninstall: (ext: { name: string }) => installed.delete(ext.name),
  };
  return { root, builtin, user, installed, registry };
}

describe("ExtensionLoader", () => {
  test("loads built-in then user extensions, keyed by origin", async () => {
    const f = fixture();
    const disabled = new Set<string>();
    const loader = new ExtensionLoader(
      f.registry,
      [
        { origin: "builtin", dir: f.builtin },
        { origin: "user", dir: f.user },
      ],
      (key) => !disabled.has(key),
    );
    const result = await loader.reload();
    expect(result.loaded.sort()).toEqual(["builtin:android.ts (android)", "user:weather.ts (weather)"]);
    expect([...f.installed.keys()].sort()).toEqual(["android", "weather"]);
    expect(loader.list().map((e) => [e.key, e.origin, e.enabled])).toEqual([
      ["builtin:android.ts", "builtin", true],
      ["user:weather.ts", "user", true],
    ]);
    expect(loader.parked()).toEqual([{ origin: "builtin", file: "_example.ts" }]);
  });

  test("a switched-off key uninstalls only that origin's file", async () => {
    const f = fixture();
    const disabled = new Set<string>();
    const loader = new ExtensionLoader(
      f.registry,
      [
        { origin: "builtin", dir: f.builtin },
        { origin: "user", dir: f.user },
      ],
      (key) => !disabled.has(key),
    );
    await loader.reload();
    disabled.add("user:weather.ts");
    const result = await loader.reload();
    expect(result.loaded).toEqual(["builtin:android.ts (android)"]);
    expect(result.skipped).toEqual(["user:weather.ts (weather)"]);
    expect([...f.installed.keys()]).toEqual(["android"]);
  });

  test("a user file that shares a built-in's name does not take the built-in down when switched off", async () => {
    const f = fixture();
    writeFileSync(join(f.user, "android.ts"), `export default { name: "android" };`);
    const disabled = new Set<string>();
    const loader = new ExtensionLoader(
      f.registry,
      [
        { origin: "builtin", dir: f.builtin },
        { origin: "user", dir: f.user },
      ],
      (key) => !disabled.has(key),
    );
    await loader.reload();
    disabled.add("user:android.ts");
    await loader.reload();
    expect(f.installed.has("android")).toBe(true);
  });

  test("removeUser deletes user files and refuses built-ins", async () => {
    const f = fixture();
    const loader = new ExtensionLoader(f.registry, [
      { origin: "builtin", dir: f.builtin },
      { origin: "user", dir: f.user },
    ]);
    expect(() => loader.removeUser("builtin:android.ts")).toThrow(/built-in/);
    await loader.reload();
    expect(loader.removeUser("user:weather.ts")).toBe("weather.ts");
    expect(existsSync(join(f.user, "weather.ts"))).toBe(false);
    const result = await loader.reload();
    expect(result.removed).toEqual(["user:weather.ts (weather)"]);
  });
});

describe("writeExtensionsTsconfig", () => {
  test("maps every paths entry to an absolute target and copies the compiler options", () => {
    const f = fixture();
    writeFileSync(
      join(f.root, "app", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "pkg/a": ["./vendor/a.js"], "pkg/b": ["./vendor/b.js"] },
          module: "esnext",
          target: "esnext",
          moduleResolution: "bundler",
        },
      }),
    );
    writeExtensionsTsconfig(join(f.root, "app"), f.user);
    const written = JSON.parse(readFileSync(join(f.user, "tsconfig.json"), "utf8")).compilerOptions;
    expect(written.baseUrl).toBe(join(f.root, "app"));
    expect(written.paths["pkg/a"]).toEqual([join(f.root, "app", "vendor", "a.js")]);
    expect(written.paths["pkg/b"]).toEqual([join(f.root, "app", "vendor", "b.js")]);
    expect(written.module).toBe("esnext");
    expect(written.moduleResolution).toBe("bundler");
  });
});
