import { describe, expect, test } from "bun:test";
import {
  buildTranscript,
  formatDuration,
  transcriptFileName,
  transcriptToJson,
  transcriptToMarkdown,
  type TranscriptMessage,
} from "./transcript.ts";

const user = (id: number, content: unknown) => ({ id, kind: "pi.user", model: [{ content }] });

const assistant = (id: number, content: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  kind: "pi.assistant",
  model: [{ provider: "test", model: "model-x", content, stopReason: "stop", ...extra }],
});

const toolResult = (id: number, callId: string, text: string, isError = false) => ({
  id,
  kind: "pi.tool-result",
  model: [{ toolCallId: callId, toolName: "bash", isError, content: [{ type: "text", text }] }],
});

const meta = { title: "Fix the parser", sessionId: 7, model: "test/model-x", thinking: "medium" };

describe("buildTranscript", () => {
  test("keeps prompts, answers, thinking, tool calls and results in log order", () => {
    const messages = buildTranscript([
      user(1, "why is it slow?"),
      assistant(2, [
        { type: "thinking", thinking: "Look at the loop." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "time bun x" } },
      ]),
      toolResult(3, "call_1", "real 0m4.2s"),
      assistant(4, [{ type: "text", text: "The loop is quadratic." }]),
    ]);

    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[0].parts?.[0].text).toBe("why is it slow?");
    expect(messages[1].thinking).toBe("Look at the loop.");
    expect(messages[1].toolCalls?.[0]).toMatchObject({ name: "bash", args: { command: "time bun x" } });
    expect(messages[2]).toMatchObject({ toolName: "bash", isError: false, text: "real 0m4.2s" });
    expect(messages[3].text).toBe("The loop is quadratic.");
  });

  test("an image in a prompt survives as a placeholder", () => {
    const messages = buildTranscript([
      user(1, [
        { type: "text", text: "what is this?" },
        { type: "image", data: "…", mimeType: "image/png" },
      ]),
    ]);
    expect(messages[0].images).toBe(1);
    expect(messages[0].parts?.map(p => p.text).join("")).toBe("what is this?[image 1]");
  });

  test("thinking and tools can be left out", () => {
    const entries = [
      assistant(2, [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c", name: "bash", arguments: {} }]),
      toolResult(3, "c", "ok"),
      assistant(4, [{ type: "text", text: "done" }]),
    ];
    const lean = buildTranscript(entries, { thinking: false, tools: false });
    expect(lean.map(m => m.role)).toEqual(["assistant", "assistant"]);
    expect(lean[0].thinking).toBeUndefined();
    expect(lean[0].toolCalls).toBeUndefined();
    expect(JSON.stringify(lean)).not.toContain("hmm");
  });

  test("model and thinking changes become event lines", () => {
    const messages = buildTranscript([
      { id: 1, kind: "pidroid.model-change", data: { fromModel: "a/b", toModel: "c/d" } },
      { id: 2, kind: "pidroid.thinking-change", data: { fromLevel: "low", toLevel: "high" } },
    ]);
    expect(messages.map(m => m.note)).toEqual([
      "Model changed: a/b → c/d",
      "Thinking level: low → high",
    ]);
  });

  test("stamps give messages, prompts and tool calls their wall clock", () => {
    // One assistant message with two blocks: the tool call at index 0, committed at e:2.
    const stamps = new Map<string, number>([
      ["b:2:0", 1000],
      ["e:2", 1600],
      ["r:call_1", 4200],
      ["b:4:0", 4300],
      ["e:4", 4500],
    ]);
    const messages = buildTranscript(
      [
        user(1, "go"),
        assistant(2, [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }]),
        toolResult(3, "call_1", "ok"),
        assistant(4, [{ type: "text", text: "done" }]),
      ],
      { stamps: key => stamps.get(key) },
    );
    expect(messages[0].at).toBe(1000); // the prompt takes the start of the run it triggered
    expect(messages[1].ms).toBe(600);
    expect(messages[1].toolCalls?.[0].ms).toBe(3200); // emitted at 1000, answered at 4200
    expect(messages[2].at).toBe(4200);
    expect(messages[3].at).toBe(4500);
  });

  test("a run still in flight is appended as a partial, not as a finished answer", () => {
    const messages = buildTranscript([user(1, "go")], {
      live: { generation: { message: { content: [{ type: "text", text: "half a thou" }] } } },
    });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", partial: true, text: "half a thou" });
  });

  test("an empty or missing log is an empty transcript, not a crash", () => {
    expect(buildTranscript(undefined)).toEqual([]);
    expect(buildTranscript([])).toEqual([]);
  });
});

describe("transcriptToMarkdown", () => {
  const entries = [
    user(1, "run the tests"),
    assistant(2, [
      { type: "thinking", thinking: "Probably the parser." },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "bun test" } },
    ]),
    toolResult(3, "call_1", "```\n2 pass, 1 fail\n```"),
    assistant(4, [{ type: "text", text: "One test fails." }]),
  ];

  test("carries the metadata header and every message", () => {
    const md = transcriptToMarkdown(buildTranscript(entries), { ...meta, createdAt: 1757000000000, updatedAt: 1757000600000 });
    expect(md.startsWith("# Fix the parser\n")).toBe(true);
    expect(md).toContain("- Model: `test/model-x`");
    expect(md).toContain("## You");
    expect(md).toContain("## Assistant · test/model-x");
    expect(md).toContain("> **Thinking**");
    expect(md).toContain("**Tool call · `bash`**");
    expect(md).toContain("**Result · `bash`**");
    // A tool result belongs to the assistant message that called it, not to the outline beside it.
    expect(md).not.toContain("## Result");
    expect(md).toContain("One test fails.");
  });

  test("a fence inside tool output does not break the fence around it", () => {
    const md = transcriptToMarkdown(buildTranscript(entries), meta);
    // The arguments have no backticks, so they get the plain fence...
    expect(md).toContain("```json\n{\n  \"command\": \"bun test\"\n}\n```");
    // ...and the output that does gets one backtick longer than its longest run.
    expect(md).toContain("````\n```\n2 pass, 1 fail\n```\n````");
  });

  test("names the branch a transcript was taken from", () => {
    const md = transcriptToMarkdown([], { ...meta, branchedFrom: "Earlier work", forkEntryId: 42 });
    expect(md).toContain("Branched from: Earlier work (at entry 42)");
  });
});

describe("transcriptToJson", () => {
  test("carries the metadata, the counts and every message", () => {
    const parsed = JSON.parse(transcriptToJson(buildTranscript([user(1, "hi"), assistant(2, [{ type: "text", text: "yo" }])]), meta));
    expect(parsed.meta.title).toBe("Fix the parser");
    expect(parsed.counts).toEqual({ user: 1, assistant: 1, toolCalls: 0, events: 0 });
    expect(parsed.messages[1].text).toBe("yo");
  });
});

describe("helpers", () => {
  test("durations read as a glance", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(3100)).toBe("3.1s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  test("file names are filesystem-safe and stamped", () => {
    const name = transcriptFileName("Fix the parser: again/again!", new Date(2026, 9, 7, 22, 31));
    expect(name).toBe("pidroid-Fix-the-parser-again-again-20261007-2231");
    expect(transcriptFileName("!!!")).toMatch(/^pidroid-session-\d{8}-\d{4}$/);
  });
});