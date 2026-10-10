/**
 * classify: ask Jev typed questions about a piece of text and get calibrated, structured
 * answers back -- numbers your code can threshold, not prose to parse.
 *
 * Jev is TypeSafe's "System One" model behind OpenCode Zen. It does not generate text: you
 * send a `state` and a set of `questions`, and it answers each one in parallel with a
 * value and a probability distribution. All three question types can be mixed in one call
 * at no extra latency.
 *
 * Endpoint: POST https://opencode.ai/zen/v1/systemone
 *   noul   -> {"noul": 0.96}                                  P(the statement is true)
 *   choice -> {"choice":"returns","confidence":1,"probabilities":{...}}
 *   score  -> {"score":0.76,"confidence":0.64,"legend":{...},"probabilities":{...}}
 *
 * On `score`, `score` is a *position on the rubric*, 0..N-1, not a probability: 0 is the
 * first option you listed and N-1 the last. It is fractional when the answer is ambiguous
 * (it is the probability-weighted expectation), so round it to get a label and read the
 * fraction as how far between two labels the text sits. `confidence` is the margin over the
 * runner-up, not the probability of the winner -- 1.0 means unanimous.
 *
 * On `noul`, the single number is the answer and the certainty in one. Threshold it where
 * the cost of being wrong says to: 0.5 when yes and no are equally cheap to act on, higher
 * when acting on a false yes costs something (paging, sending, refusing), lower when a
 * missed yes costs something.
 *
 * Why this exists alongside the chat models: asking a chat model "is this urgent?" and
 * parsing yes/no out of its reply gets you a guess with a confident tone. Jev gets you a
 * number you can branch on, for free, without spending a generation.
 *
 * Auth: `jev-1.13-free` works with no key at all (verified 2026-10-09 -- note the free tier
 * gate that blocks the chat models for anonymous callers does not cover this endpoint).
 * `jev-1.13` needs an OpenCode Zen key from https://opencode.ai/auth, and is a paid model.
 *
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const SYSTEMONE_URL = "https://opencode.ai/zen/v1/systemone";
const DEFAULT_MODEL = "jev-1.13-free";
const MODEL_WITH_KEY = "jev-1.13";

/** Keeps a paste of a whole file from turning into an unreasonable request. */
const MAX_STATE_CHARS = 60_000;
/** Questions are free in latency but not in sense; past this, stop and think. */
const MAX_QUESTIONS = 16;

const QUESTION_TYPE = Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")]);

const questionSchema = Type.Object({
  id: Type.String({ description: "Your name for this question. Echoed back as the key of its answer." }),
  type: QUESTION_TYPE,
  instructions: Type.String({
    description:
      "One specific question, or a statement to judge for truth. Ask one thing: for a " +
      "judgement that weighs several factors, ask a question per factor and combine the " +
      "answers in your own code.",
  }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Required for choice (the labels to pick between) and score (the rubric levels, " +
        "lowest first -- score 0 is the first, N-1 the last). Unused for noul.",
    }),
  ),
});

interface Question {
  id: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  options?: string[];
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}
interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}
type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The wire shape, which we trust as little as the network leaves us able to. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One answer, as a line the model can act on. Deliberately keeps the number and the label
 * side by side: a threshold on the number is the decision, the label is for reporting it.
 */
export function formatAnswer(id: string, answer: Answer): string {
  const pad = id.padEnd(20);
  if (answer.type === "noul") {
    return `${pad}${answer.noul.toFixed(2)} ${answer.noul >= 0.5 ? "yes" : "no "}`;
  }

  if (answer.type === "choice") {
    const winner = Number(answer.probabilities[answer.choice] ?? 0);
    // A certain winner leaves the spread as a list of zeroes, so it is not worth the line.
    if (winner >= 0.999) return `${pad}${answer.choice}  (unanimous)`;
    const spread = Object.entries(answer.probabilities)
      .map(([k, v]) => `${k} ${Number(v).toFixed(2)}`)
      .join(" · ");
    return `${pad}${answer.choice}  (confidence ${answer.confidence.toFixed(2)}; ${spread})`;
  }

  // score: a rubric position. Round to the nearest label, keep the fraction beside it so an
  // ambiguous 0.76 between "Frustrated" and "Very angry" reads as what it is.
  const whole = Number.isInteger(answer.score);
  const value = whole ? String(answer.score) : `${answer.score.toFixed(2)} ->`;
  const legend = Object.entries(answer.legend ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  if (legend.length === 0) {
    // No legend to point at, so the number is all there is -- do not invent a level.
    return `${pad}${whole ? String(answer.score) : answer.score.toFixed(2)}  (confidence ${answer.confidence.toFixed(2)}; no rubric returned)`;
  }
  const level = Math.max(0, Math.min(legend.length - 1, Math.round(answer.score)));
  const label = legend[level]?.[1] ?? `level ${level}`;
  const rubric = legend.map(([, v]) => v).join(" · ");
  return `${pad}${value} ${whole ? "" : `"${label}" `}(confidence ${answer.confidence.toFixed(2)}; rubric ${rubric})`;
}

/** Turns the tool's arguments into the request body, rejecting what the API would choke on. */
export function buildRequest(state: string, questions: Question[], model: string) {
  if (!state.trim()) throw new Error("state is empty: there is nothing to evaluate.");
  if (questions.length === 0) throw new Error("no questions: classify needs at least one.");
  if (questions.length > MAX_QUESTIONS) throw new Error(`${questions.length} questions is more than ${MAX_QUESTIONS}; ask fewer, or ask the sharpest ones.`);

  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.id.trim()) throw new Error("a question has an empty id.");
    if (seen.has(q.id)) throw new Error(`duplicate question id "${q.id}": ids must be unique, they become the answer keys.`);
    seen.add(q.id);
    if (!q.instructions.trim()) throw new Error(`question "${q.id}" has no instructions.`);
    if (q.type !== "noul") {
      const options = q.options ?? [];
      if (options.length < 2) throw new Error(`question "${q.id}" is a ${q.type}: list at least two options. A ${q.type} needs something to choose or score between.`);
      if (new Set(options.map((o) => o.trim().toLowerCase())).size !== options.length) throw new Error(`question "${q.id}" repeats an option; duplicates make the choice meaningless.`);
    }
  }

  const record: Record<string, unknown> = {};
  for (const q of questions) {
    const entry: Record<string, unknown> = { type: q.type, instructions: q.instructions };
    // The two criteria shapes are not interchangeable: a choice takes a map of label to
    // description, a score takes the rubric itself as an ordered array. Sending a score a
    // map is a 422 from the gateway, not a silent downgrade. noul takes a {true,false}
    // object and the instructions already say what is being judged, so its options are
    // dropped rather than forwarded as a bogus array.
    if (q.options && q.type === "choice") entry.criteria = Object.fromEntries(q.options.map((o) => [o, o]));
    if (q.options && q.type === "score") entry.criteria = [...q.options];
    record[q.id] = entry;
  }
  return { model, state, questions: record };
}

const classify = defineTool({
  name: "classify",
  view: { verb: { one: "classified text", many: "classified text {n} times" } },
  description:
    "Ask Jev, a free System One classifier on OpenCode Zen, typed questions about a piece of text. " +
    "It returns calibrated numbers instead of prose: a noul is a 0-1 probability that a statement is true; " +
    "a choice picks one of the labels you listed and reports its probability spread; a score places the text " +
    "on a rubric, 0 for the first option and N-1 for the last, fractional when the answer is ambiguous. " +
    "All three can be asked in one call, each answered in parallel. " +
    "Use it to make a decision your own code will branch on -- is this urgent, is this about billing, " +
    "which of these labels fits, how far along this rubric -- rather than to summarise, name, or explain anything, " +
    "which is text generation and this model cannot do. Threshold the numbers in your own logic: raise the bar " +
    "when acting on a false yes is expensive, lower it when a missed yes is. No API key is needed.",
  parameters: Type.Object({
    state: Type.String({ description: "The text to evaluate: a message, a diff, a file, an answer to check. Judged as a whole, so include the context a question needs." }),
    questions: Type.Array(questionSchema, { description: "The questions to ask, each answered independently against the same state." }),
    model: Type.Optional(Type.String({ description: `"${DEFAULT_MODEL}" (free, no key) by default. "${MODEL_WITH_KEY}" is the paid model and needs an OpenCode Zen key.` })),
  }),
  // Idempotent: classifying the same text twice gives the same answer, so a replay is harmless.
  replay: "safe",
  execute: async (args, api) => {
    const state = String(args.state ?? "");
    const questions = (args.questions ?? []) as Question[];
    const model = String(args.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

    if (state.length > MAX_STATE_CHARS) throw new Error(`state is ${state.length} characters, over the ${MAX_STATE_CHARS} limit. Trim it to the part the questions are about.`);

    const body = buildRequest(state, questions, model);

    let response: Response;
    try {
      response = await fetch(SYSTEMONE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer public" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Could not reach ${SYSTEMONE_URL}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      // The gateway reports failures as {"error":{"type":...,"message":...}}; pass the message on.
      const message = isRecord(payload) && isRecord(payload.error) ? String(payload.error.message ?? "") : "";
      throw new Error(`Jev answered HTTP ${response.status}${message ? `: ${message}` : ` for model "${model}"`}`);
    }
    if (!isRecord(payload) || !isRecord(payload.answers)) {
      throw new Error(`Jev answered 200 but with no answers for model "${model}": ${JSON.stringify(payload).slice(0, 300)}`);
    }

    const lines = questions.map((q) => {
      const raw = payload.answers[q.id];
      if (!isRecord(raw)) return `${q.id.padEnd(20)}(no answer returned)`;
      return formatAnswer(q.id, raw as unknown as Answer);
    });

    const usage = isRecord(payload.usage) ? payload.usage : undefined;
    const footer = [
      model,
      usage ? `${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out` : "",
      response.ok ? "free" : "",
    ].filter(Boolean).join(" · ");
    if (footer) lines.push("", footer);

    api.output(lines.join("\n"));
    return {};
  },
});

export default defineExtension({
  name: "jev-classify",
  tools: [classify],
});
