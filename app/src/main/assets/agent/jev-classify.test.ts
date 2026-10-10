import { describe, expect, test } from "bun:test";
import { buildRequest, formatAnswer } from "./extensions/jev-classify";

const q = (over: Partial<{ id: string; type: "noul" | "choice" | "score"; instructions: string; options?: string[] }> = {}) => ({
  id: "q",
  type: "noul" as const,
  instructions: "Is this urgent?",
  ...over,
});

describe("buildRequest", () => {
  test("noul sends type and instructions only", () => {
    const body = buildRequest("payments failing", [q()], "jev-1.13-free");
    expect(body).toEqual({
      model: "jev-1.13-free",
      state: "payments failing",
      questions: { q: { type: "noul", instructions: "Is this urgent?" } },
    });
  });

  test("choice turns the options into the criteria map", () => {
    const body = buildRequest("I want a refund", [q({ type: "choice", options: ["returns", "shipping", "billing"] })], "jev-1.13-free");
    expect(body.questions.q).toEqual({
      type: "choice",
      instructions: "Is this urgent?",
      criteria: { returns: "returns", shipping: "shipping", billing: "billing" },
    });
  });

  // A score's rubric must go as an ordered array: sending it a map is a 422 from the
  // gateway, which is how this was caught -- the raw docs example worked over curl and
  // failed through the tool because of exactly this.
  test("score sends the rubric as an ordered array", () => {
    const body = buildRequest("late and damaged", [q({ type: "score", options: ["Calm", "Frustrated", "Very angry"] })], "jev-1.13-free");
    expect((body.questions.q as { criteria: string[] }).criteria).toEqual(["Calm", "Frustrated", "Very angry"]);
  });

  test("choice still sends a map, not the array a score needs", () => {
    const body = buildRequest("state", [q({ type: "choice", options: ["a", "b"] })], "m");
    expect(Array.isArray((body.questions.q as { criteria: unknown }).criteria)).toBe(false);
    expect((body.questions.q as { criteria: object }).criteria).toEqual({ a: "a", b: "b" });
  });

  test("rejects an empty state", () => {
    expect(() => buildRequest("   ", [q()], "m")).toThrow(/nothing to evaluate/);
  });

  test("rejects no questions", () => {
    expect(() => buildRequest("state", [], "m")).toThrow(/at least one/);
  });

  test("rejects a duplicate id", () => {
    expect(() => buildRequest("state", [q({ id: "a" }), q({ id: "a", instructions: "other" })], "m")).toThrow(/must be unique/);
  });

  test("rejects a question with no instructions", () => {
    expect(() => buildRequest("state", [q({ instructions: "  " })], "m")).toThrow(/no instructions/);
  });

  // A choice with nothing to choose between, or one option, is meaningless and the gateway
  // would answer it arbitrarily -- better to say so than to return a confident label.
  test("choice needs at least two options", () => {
    expect(() => buildRequest("state", [q({ type: "choice", options: ["only-one"] })], "m")).toThrow(/at least two options/);
    expect(() => buildRequest("state", [q({ type: "choice" })], "m")).toThrow(/at least two options/);
  });

  test("score needs at least two options", () => {
    expect(() => buildRequest("state", [q({ type: "score", options: ["a"] })], "m")).toThrow(/at least two options/);
  });

  // noul takes a {true,false} object rather than a list, and the instructions already say
  // what is being judged, so options are dropped rather than sent as a bogus array criteria.
  test("noul drops options instead of sending an array as criteria", () => {
    const body = buildRequest("state", [q({ options: ["true", "false"] })], "m");
    expect(body.questions.q).toEqual({ type: "noul", instructions: "Is this urgent?" });
  });

  test("noul needs no options at all", () => {
    const body = buildRequest("state", [q()], "m");
    expect(body.questions.q).toEqual({ type: "noul", instructions: "Is this urgent?" });
  });

  test("rejects a repeated option", () => {
    expect(() => buildRequest("state", [q({ type: "choice", options: ["a", "A"] })], "m")).toThrow(/repeats an option/);
  });
});

describe("formatAnswer", () => {
  test("noul prints the probability next to its reading", () => {
    expect(formatAnswer("is_urgent", { type: "noul", noul: 0.96 })).toBe("is_urgent           0.96 yes");
    expect(formatAnswer("is_urgent", { type: "noul", noul: 0.03 })).toBe("is_urgent           0.03 no ");
    // Let the caller place the threshold: the number is the answer.
    expect(formatAnswer("borderline", { type: "noul", noul: 0.5 })).toBe("borderline          0.50 yes");
  });

  test("choice prints the winner, and the spread when there is one", () => {
    expect(formatAnswer("dept", { type: "choice", choice: "returns", confidence: 1, probabilities: { returns: 1, shipping: 0, billing: 0 } })).toBe(
      "dept                returns  (unanimous)",
    );
    expect(formatAnswer("dept", { type: "choice", choice: "returns", confidence: 0.4, probabilities: { returns: 0.7, shipping: 0.3, billing: 0 } })).toBe(
      "dept                returns  (confidence 0.40; returns 0.70 · shipping 0.30 · billing 0.00)",
    );
  });

  // A whole-number score is a rubric position; the label is what it points at.
  test("score on a level prints that level", () => {
    const out = formatAnswer("frustration", { type: "score", score: 2, confidence: 1, legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" }, probabilities: { "0": 0, "1": 0, "2": 1 } });
    expect(out).toContain("2 ");
    expect(out).toContain("Very angry");
    expect(out).toContain("confidence 1.00");
  });

  // A fractional score is between two levels: keep the number AND the label, because the
  // number is what a threshold acts on and the label is what gets reported.
  test("a fractional score keeps the number and the label", () => {
    const out = formatAnswer("frustration", { type: "score", score: 0.76, confidence: 0.64, legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" }, probabilities: { "0": 0.24, "1": 0.76, "2": 0 } });
    expect(out).toContain("0.76 ->");
    expect(out).toContain('"Frustrated"');
    expect(out).toContain("confidence 0.64");
    expect(out).toContain("rubric Calm · Frustrated · Very angry");
  });

  test("a score is clamped to the rubric, not thrown away", () => {
    const out = formatAnswer("f", { type: "score", score: 9, confidence: 1, legend: { "0": "low", "1": "high" }, probabilities: { "0": 0, "1": 1 } });
    expect(out).toContain("high");
    expect(out).not.toContain("level 9");
  });

  // A score with no legend has no level to name, so it must not invent one (it used to
  // clamp to -1 and print "level -1").
  test("a score with an unreadable legend reports the number, not a bogus level", () => {
    const out = formatAnswer("f", { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} });
    expect(out).toContain("1 ");
    expect(out).toContain("no rubric returned");
    expect(out).not.toContain("level -1");
  });

  test("the rubric is ordered by index, not by key order", () => {
    const out = formatAnswer("f", { type: "score", score: 2, confidence: 1, legend: { "2": "high", "0": "low", "1": "mid" }, probabilities: { "0": 0, "1": 0, "2": 1 } });
    expect(out).toContain("rubric low · mid · high");
  });

  test("pads the column so several answers line up", () => {
    expect(formatAnswer("a", { type: "noul", noul: 1 }).indexOf("1.00")).toBe(20);
    expect(formatAnswer("a-much-longer-id", { type: "noul", noul: 1 }).indexOf("1.00")).toBe(20);
  });
});
