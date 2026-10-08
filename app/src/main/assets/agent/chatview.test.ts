import { describe, expect, test } from "bun:test";
import { ChatViewBuilder, liveDelta, type Block } from "./chatview.ts";
import { blockStartKey, messageEndKey, toolEndKey } from "./timings.ts";

const models = {
  getModel: () => ({ contextWindow: 32_000 } as any),
};

function userEntry(id: number, text: string) {
  return { id, kind: "pi.user", model: [{ content: text }] };
}

function assistantEntry(id: number, content: unknown[], usage: Record<string, any> = {}) {
  return {
    id,
    kind: "pi.assistant",
    model: [{ provider: "test", model: "model", content, usage, stopReason: "stop" }],
  };
}

function snapshot(entries: unknown[], live?: unknown, inbox: unknown[] = []) {
  return { entries, docs: { "pi.live": live, "pi.inbox": { items: inbox } } };
}

describe("ChatViewBuilder", () => {
  test("reuses the committed transcript while only the live partial changes", () => {
    const builder = new ChatViewBuilder();
    const entries = [
      userEntry(1, "Explain the result"),
      assistantEntry(2, [{ type: "text", text: "**Committed answer**" }], {
        input: 8,
        output: 5,
        totalTokens: 13,
        cost: { total: 0.02 },
      }),
    ];
    const initial = builder.build(snapshot(entries), models);
    const streaming = builder.build(snapshot(entries, {
      run: true,
      generation: { message: { content: [{ type: "text", text: "partial answer" }] } },
      tools: [],
    }), models);

    expect(streaming.messages).toBe(initial.messages);
    expect(streaming.messages).toHaveLength(2);
    expect(streaming.live?.blocks[0].text).toBe("partial answer");
    expect(streaming.busy).toBe(true);
  });

  test("sends committed text as plain text, the page renders it", () => {
    const builder = new ChatViewBuilder();
    const view = builder.build(snapshot([
      userEntry(1, "Explain"),
      assistantEntry(2, [{ type: "text", text: "# Heading\n\n**bold**" }]),
    ]), models);

    expect(view.messages[1].blocks?.[0]).toEqual({ type: "text", text: "# Heading\n\n**bold**" });
  });

  test("appends new messages without mutating the previously published array", () => {
    const builder = new ChatViewBuilder();
    const first = builder.build(snapshot([userEntry(1, "first")]), models);
    const next = builder.build(snapshot([
      userEntry(1, "first"),
      assistantEntry(2, [{ type: "text", text: "reply" }]),
    ]), models);

    expect(next.messages).not.toBe(first.messages);
    expect(first.messages).toHaveLength(1);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].branchAfter).toBe(2);
  });

  test("a later tool result refreshes the cached call duration", () => {
    const builder = new ChatViewBuilder();
    const stamps = new Map<string, number>([
      [blockStartKey(2, 0), 100],
      [messageEndKey(2), 200],
    ]);
    const timing = (key: string) => stamps.get(key);
    const call: Block = { type: "toolCall", id: "call-1", name: "bash", args: { command: "pwd" } };
    const first = builder.build(snapshot([
      userEntry(1, "run a command"),
      assistantEntry(2, [call], { input: 3, totalTokens: 3 }),
    ]), models, timing);
    expect(first.messages[1].blocks?.[0].ms).toBe(100);

    stamps.set(toolEndKey("call-1"), 450);
    const next = builder.build(snapshot([
      userEntry(1, "run a command"),
      assistantEntry(2, [call], { input: 3, totalTokens: 3 }),
      {
        id: 3,
        kind: "pi.tool-result",
        model: [{ toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }] }],
      },
    ]), models, timing);

    expect(next.messages[1].blocks?.[0].ms).toBe(350);
    expect(next.messages[2].text).toBe("ok");
  });

  test("a replaced or truncated log falls back to a clean build", () => {
    const builder = new ChatViewBuilder();
    builder.build(snapshot([userEntry(1, "old"), assistantEntry(2, [{ type: "text", text: "old reply" }])]), models);
    const replacement = builder.build(snapshot([userEntry(10, "new branch")]), models);

    expect(replacement.messages).toHaveLength(1);
    expect(replacement.messages[0].id).toBe(10);
    expect(replacement.messages[0].branchBefore).toBeUndefined();
  });
});

describe("liveDelta", () => {
  const text = (s: string, extra = {}): Block => ({ type: "text", text: s, ...extra });

  test("sends only the appended suffix of a block that grew", () => {
    const out: any = liveDelta({ blocks: [text("hello world", { at: 5 })] }, { blocks: [text("hello")] });
    expect(out.delta).toBe(true);
    expect(out.blocks[0]).toEqual({ type: "text", at: 5, append: " world" });
  });

  test("sends a rewritten block, a new block and a tool call whole", () => {
    const call: Block = { type: "toolCall", id: "c", name: "bash", args: {} };
    const out: any = liveDelta(
      { blocks: [text("changed"), text("new"), call] },
      { blocks: [text("original")] },
    );
    expect(out).toEqual({ blocks: [text("changed"), text("new"), call] });
  });

  test("passes through when there is nothing to build on, and clears when there is no live", () => {
    const live = { blocks: [text("hi")] };
    expect(liveDelta(live, undefined)).toBe(live);
    expect(liveDelta(undefined, live)).toBeNull();
  });
});
