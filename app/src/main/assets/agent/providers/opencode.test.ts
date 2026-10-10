import { describe, expect, test } from "bun:test";
import { isChatSurface, usableFreeId } from "./opencode";

/**
 * specs: id -> what models.dev says. `undefined` = models.dev has not listed it.
 */
const spec = (zeroCost?: boolean) => ({ name: "x", reasoning: true, image: false, context: 1, output: 1, ...(zeroCost === undefined ? {} : { zeroCost }) });

const CHAT = "https://opencode.ai/zen/v1/chat/completions";
const RESPONSES = "https://opencode.ai/zen/v1/responses";
const MESSAGES = "https://opencode.ai/zen/v1/messages";
const SYSTEMONE = "https://opencode.ai/zen/v1/systemone";
const GEMINI = "https://opencode.ai/zen/v1/models/gemini-3.8-flash";

/** The shape of a row from Zen's published model table. */
const row = (name: string, id: string, endpoint: string) => `| ${name} | ${id} | \`${endpoint}\` | \`@ai-sdk/x\` |`;
const TABLE = [
  "| Model | Model ID | Endpoint | AI SDK Package |",
  "| --- | --- | --- | --- |",
  row("Big Pickle", "big-pickle", CHAT),
  row("Jev 1.13 Free", "jev-1.13-free", SYSTEMONE),
  row("Muse Spark 1.3", "muse-spark-1.3-contributor-free", RESPONSES),
  row("Gemini 3.8 Flash", "gemini-3.8-flash", GEMINI),
  row("Kimi K3", "kimi-k3", MESSAGES),
  "",
  "Unrelated table (prices) that the parser must ignore:",
  "| Model | Output |",
  "| --- | --- |",
  "| Big Pickle | $1.20 |",
].join("\n");

describe("usableFreeId (cost cross-check)", () => {
  test("keeps an id models.dev lists as free", () => {
    expect(usableFreeId("space-bunny-free", new Map([["space-bunny-free", spec(true)]]))).toBe(true);
  });

  // Zen announces new free models before models.dev picks them up, so a miss is not a disqualification.
  test("keeps an id models.dev has not listed yet", () => {
    expect(usableFreeId("jev-1.13-free", new Map([["space-bunny-free", spec(true)]]))).toBe(true);
  });

  test("keeps every id when models.dev is unreachable (empty map)", () => {
    const specs = new Map();
    expect(usableFreeId("jev-1.13-free", specs)).toBe(true);
    expect(usableFreeId("space-bunny-free", specs)).toBe(true);
  });

  test("drops an id models.dev lists with a price", () => {
    expect(usableFreeId("gpt-5-nano", new Map([["gpt-5-nano", spec(false)]]))).toBe(false);
  });
});

describe("isChatSurface (API-shape check)", () => {
  const endpoints = new Map([
    ["big-pickle", CHAT],
    ["muse-spark-1.3-contributor-free", RESPONSES],
    ["kimi-k3", MESSAGES],
    ["gemini-3.8-flash", GEMINI],
    ["jev-1.13-free", SYSTEMONE],
  ]);

  // The classifier: free and reachable, but it answers a set of questions by id instead of
  // generating text, so offering it as a chat model is wrong.
  test("drops a /v1/systemone route (jev-1.13-free)", () => {
    expect(isChatSurface("jev-1.13-free", endpoints)).toBe(false);
  });

  test("keeps every chat dialect", () => {
    expect(isChatSurface("big-pickle", endpoints)).toBe(true);
    expect(isChatSurface("muse-spark-1.3-contributor-free", endpoints)).toBe(true);
    expect(isChatSurface("kimi-k3", endpoints)).toBe(true);
  });

  // Native per-model passthroughs are a different shape too, though none are free today.
  test("drops a native /v1/models/<name> passthrough", () => {
    expect(isChatSurface("gemini-3.8-flash", endpoints)).toBe(false);
  });

  // A statement about API shape, not a gate: an unlisted model stays in the chooser.
  test("keeps an id the docs table does not list", () => {
    expect(isChatSurface("brand-new-model-free", endpoints)).toBe(true);
  });

  test("keeps everything when the docs are unreachable", () => {
    expect(isChatSurface("jev-1.13-free", new Map())).toBe(true);
  });
});
