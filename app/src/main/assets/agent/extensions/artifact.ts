/**
 * artifact: put something in the chat that is meant to be looked at.
 *
 * The transcript has two kinds of content and they are not the same kind. Commands, reads and
 * searches are working: the chat view sums a run of them into one collapsed line ("Ran 5
 * commands, read a file") that expands on demand, because nobody reads ten command lines to find
 * the sentence after them. An artifact is the other kind -- a graph, a rendered page, a table of
 * results, a listing worth more than a paragraph -- and collapsing it would bury the one thing in
 * the turn that was put there for the reader. So these calls are marked standalone and the view
 * renders them as cards, in the open, never folded into a run of other work.
 *
 * It replaces plot_function, which did one of these kinds (the graph) with a tool of its own.
 * The maths below is that file's, unchanged, and for the same reason: the expression is tokenised
 * and evaluated HERE, by hand, so a hostile expression costs a parse error instead of the
 * WebView. Nothing in this file uses eval() or new Function(), there are no loops, no property
 * access and no way to reach Bun. Only x, the constants and the function table exist as names, and
 * only numbers cross the wire -- the page maps samples onto an SVG polyline and does nothing else.
 *
 * How the payload reaches the page, and why it is shaped like this:
 *
 *  - The tool view system (extensions.ts) is declarative on purpose: a view picks a renderer that
 *    already exists in the page, because an extension's code cannot be shipped into the WebView.
 *    "artifact" is such a renderer -- www/artifact.js, next to the graph drawing.
 *
 *  - The payload travels as the last line of the tool's own output, a {"artifact":{...}} JSON
 *    object, the same trick web_search uses with its result cards. The UI gets exactly what the
 *    model gets, so there is no second format to keep in step with the first, and a payload that
 *    will not parse cannot cost the record: the caller falls back to the raw text.
 *
 *  - It has to stay small: chatview.ts clips tool text at 6000 characters, so the graph rounds its
 *    numbers and halves the sample count until it fits, and a listing is clipped to what fits.
 *
 *  - An HTML artifact is not markup in the transcript. It is written to this session's workspace
 *    and shown through the workspace URL, inside a frame with no allow-same-origin -- the same
 *    arrangement the Artifacts screen uses. A model-authored page then runs in an opaque origin
 *    and cannot reach the app holding the session. It also means the page is a real file: the
 *    reader can open it full screen, copy it, and it is still there next turn.
 *
 * After editing, call reload_extensions. No restart needed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** The app directory: the session workspaces are one directory above it, one per conversation. */
const APP_DIR = dirname(import.meta.dir);
const WORKSPACES_DIR = join(dirname(APP_DIR), "workspaces");
const workspaceDir = (conversationId: number | bigint) => join(WORKSPACES_DIR, String(conversationId));

/** Where artifacts land inside a workspace, and the longest listing that fits in a tool result. */
const ARTIFACT_DIR = "artifacts";
const MAX_TEXT = 4000;
const MAX_ROWS = 60;
const MAX_CELL = 160;

// ---------------------------------------------------------------------------------------------
// graph: tokenizer
// ---------------------------------------------------------------------------------------------

type Tok =
  | { kind: "num"; value: number; at: number }
  | { kind: "name"; value: string; at: number }
  | { kind: "op"; value: string; at: number }
  | { kind: "(" | ")" | ","; at: number };

/** Unicode look-alikes an agent or a human reaches for when typing maths on a phone keyboard. */
const OP_ALIASES: Record<string, string> = { "−": "-", "–": "-", "×": "*", "·": "*", "⋅": "*", "÷": "/", "，": "," };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") { i++; continue; }
    if (ch in OP_ALIASES) { out.push({ kind: "op", value: OP_ALIASES[ch], at: i }); i++; continue; }
    if (ch >= "0" && ch <= "9" || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      // A number: digits, one dot, an exponent. 1e-3 is a number; a bare "e" would be Euler's.
      const rest = src.slice(i);
      const m = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!m) throw new Error(`cannot read a number at position ${i + 1}`);
      out.push({ kind: "num", value: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_πφ]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z_0-9πφ]+/);
      if (!m) throw new Error(`cannot read a name at position ${i + 1}`);
      out.push({ kind: "name", value: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if ("+-*/%^".includes(ch)) { out.push({ kind: "op", value: ch, at: i }); i++; continue; }
    if (ch === "(" || ch === ")" || ch === ",") { out.push({ kind: ch, at: i }); i++; continue; }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at position ${i + 1}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------------------------

const CONSTANTS: Record<string, number> = { pi: Math.PI, "π": Math.PI, tau: Math.PI * 2, e: Math.E };

/** Unary functions: name -> arity 1. `log` is the natural logarithm, as on a calculator. */
const UNARY: Record<string, (a: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  exp: Math.exp, ln: Math.log, log: Math.log, log2: Math.log2, log10: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
};

/** Binary functions: name -> arity 2. */
const BINARY: Record<string, (a: number, b: number) => number> = {
  pow: (a, b) => a ** b,
  atan2: Math.atan2,
  hypot: Math.hypot,
  max: Math.max, min: Math.min,
  mod: (a, b) => ((a % b) + b) % b,
};

/**
 * A CSS cubic-bezier timing function, as a function of the progress x: y is how far along the
 * animated property is, x how far along the duration is.
 *
 * A bezier is parametric -- (x(t), y(t)) for a parameter t -- and CSS uses t as *time*, not as x.
 * So the y that belongs to a given x needs the parameter solved for. Bisection, because x(t) rises
 * monotonically as long as both control points lie in [0,1], which CSS requires and which is
 * checked when the curve is built; without that guarantee a bisection would silently pick the
 * wrong branch. 40 halvings of [0,1] is well past the precision the drawing needs.
 */
/** CSS requires both x control points in [0,1]; that is also what makes x(t) monotone, which is
 *  what lets the curve below be inverted by bisection. Checked on its own so the parser can reject
 *  a bad literal before sampling starts, not 240 samples in. */
function checkBezierPoints(p1x: number, p2x: number) {
  if (!(p1x >= 0 && p1x <= 1) || !(p2x >= 0 && p2x <= 1)) {
    throw new Error(`cubic_bezier() needs its x control points in [0,1] (CSS requires it), got ${p1x} and ${p2x}`);
  }
}

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  checkBezierPoints(x1, x2);
  const bez = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (x: number) => {
    // Outside the unit interval there is no curve to be on: CSS clamps progress at both ends.
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (bez(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return bez(y1, y2, (lo + hi) / 2);
  };
}

/**
 * Functions of a fixed arity above 2. They take the current x as well as their arguments, because
 * a bezier's result depends on where along the curve we are -- which is the whole point of it.
 */
const NARY: Record<string, { arity: number; fn: (x: number, args: number[]) => number }> = {
  cubic_bezier: { arity: 4, fn: (x, [a, b, c, d]) => bezier(a, b, c, d)(x) },
};

/**
 * Curves written bare, as in CSS, where the keyword stands for the whole function rather than a
 * call. These are what a transition actually uses -- `transition: transform 0.2s ease` is the same
 * curve as cubic_bezier(0.25, 0.1, 0.25, 1).
 */
const CURVES: Record<string, (x: number) => number> = {
  // Clamped like the beziers, so every curve behaves the same outside [0,1].
  linear: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x),
  ease: bezier(0.25, 0.1, 0.25, 1),
  ease_in: bezier(0.42, 0, 1, 1),
  ease_out: bezier(0, 0, 0.58, 1),
  ease_in_out: bezier(0.42, 0, 0.58, 1),
};

/** These take any number of arguments, as they do on a calculator: min(3, 1, 2) is normal. */
const VARIADIC = new Set(["min", "max"]);

const FUNCTION_NAMES = [...Object.keys(UNARY), ...Object.keys(BINARY), ...Object.keys(NARY)].sort().join(", ");
/** The CSS keywords, which are curves in their own right rather than calls. */
const CURVE_NAMES = Object.keys(CURVES).join(", ");

// ---------------------------------------------------------------------------------------------
// parser
//
// Precedence climbing. `power` sits below unary minus and is right-associative, so -2^2 is
// -(2^2) as everyone expects, and 2^-1 works. Implicit multiplication (2x, 3pi, 2(x+1)) falls
// out of term(): after a factor, if the next token could start one, multiply.
// ---------------------------------------------------------------------------------------------

type Node =
  | { k: "num"; v: number }
  | { k: "var" }
  | { k: "const"; v: number }
  | { k: "curve"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private isOp(value: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "op" && t.value === value;
  }
  private expect(kind: Tok["kind"], what: string): Tok {
    const t = this.next();
    if (!t || t.kind !== kind) throw new Error(`expected ${what}${t ? ` but found ${describe(t)}` : " but the expression ended"}`);
    return t;
  }

  parse(): Node {
    const node = this.expr();
    const left = this.peek();
    if (left) throw new Error(`unexpected ${describe(left)} at position ${left.at + 1}`);
    return node;
  }

  private expr(): Node {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next() as { value: string };
      left = { k: "bin", op: op.value, a: left, b: this.term() };
    }
    return left;
  }

  private term(): Node {
    let left = this.unary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
        const op = (this.next() as { value: string }).value;
        left = { k: "bin", op, a: left, b: this.unary() };
        continue;
      }
      // Implicit multiplication: 2x, 3pi, 2(x+1), (x+1)(x-1). A name that is not a known
      // function is left to atom(), which rejects it with a proper message.
      const t = this.peek();
      if (t && (t.kind === "num" || t.kind === "name" || (t.kind as string) === "(")) {
        left = { k: "bin", op: "*", a: left, b: this.unary() };
        continue;
      }
      return left;
    }
  }

  private unary(): Node {
    if (this.isOp("-")) { this.next(); return { k: "neg", a: this.unary() }; }
    if (this.isOp("+")) { this.next(); return this.unary(); }
    return this.power();
  }

  private power(): Node {
    const base = this.atom();
    if (this.isOp("^")) { this.next(); return { k: "bin", op: "^", a: base, b: this.unary() }; }
    return base;
  }

  private atom(): Node {
    const t = this.next();
    if (!t) throw new Error("the expression ended where a value was expected");
    if (t.kind === "num") return { k: "num", v: t.value };
    if (t === "(" || t.kind === "(") {
      const inner = this.expr();
      this.expect(")", "a closing )");
      return inner;
    }
    if (t.kind === "name") {
      if (t.value === "x") return { k: "var" };
      if (t.value in CONSTANTS) return { k: "const", v: CONSTANTS[t.value] };
      const next = this.peek();
      // A CSS keyword stands for the whole curve, not a call: `ease`, never `ease()`.
      if (t.value in CURVES && next?.kind !== "(") return { k: "curve", name: t.value };
      const isCall = (next?.kind as string) === "(";
      if (isCall) {
        this.next(); // (
        const args: Node[] = [];
        if ((this.peek()?.kind as string) !== ")") {
          args.push(this.expr());
          while ((this.peek()?.kind as string) === ",") { this.next(); args.push(this.expr()); }
        }
        this.expect(")", `a closing ) for ${t.value}(`);
        const arity = t.value in UNARY ? 1 : t.value in BINARY ? 2 : NARY[t.value]?.arity ?? 0;
        if (!arity) throw new Error(`unknown function ${JSON.stringify(t.value)}. Known: ${FUNCTION_NAMES}`);
        if (VARIADIC.has(t.value) ? args.length < 1 : args.length !== arity) {
          throw new Error(`${t.value}() takes ${VARIADIC.has(t.value) ? "at least one argument" : `${arity} argument${arity > 1 ? "s" : ""}`}, got ${args.length}`);
        }
        // A bezier written out in plain numbers can be checked now, so the model is told the
        // control points are wrong before anything is sampled. Computed ones are checked when the
        // first sample evaluates them.
        if (t.value === "cubic_bezier" && args.every((a) => a.k === "num")) {
          const [p1x, , p2x] = args as { k: "num"; v: number }[];
          checkBezierPoints(p1x.v, p2x.v);
        }
        return { k: "call", name: t.value, args };
      }
      throw new Error(`unknown name ${JSON.stringify(t.value)}. Use x, a constant (${Object.keys(CONSTANTS).join(", ")}), a CSS timing curve (${CURVE_NAMES}) or one of: ${FUNCTION_NAMES}`);
    }
    throw new Error(`unexpected ${describe(t)} where a value was expected`);
  }
}

function describe(t: Tok): string {
  return t.kind === "op" ? JSON.stringify(t.value) : t.kind === "num" ? String(t.value) : JSON.stringify(t.kind === "name" ? t.value : t.kind);
}

/** Parse an expression in x into a tree. Throws with a message meant for the model to read. */
function compile(src: string): Node {
  const text = src.trim();
  if (!text) throw new Error("the expression is empty");
  if (text.length > 400) throw new Error(`the expression is ${text.length} characters; keep it under 400`);
  return new Parser(tokenize(text)).parse();
}

// ---------------------------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------------------------

/** Beyond this the number is noise on a graph, not a value: treat it as a gap. */
const MAGNITUDE_LIMIT = 1e12;

function evaluate(node: Node, x: number): number {
  switch (node.k) {
    case "num": return node.v;
    case "const": return node.v;
    case "var": return x;
    case "curve": return CURVES[node.name](x);
    case "neg": return -evaluate(node.a, x);
    case "bin": {
      const a = evaluate(node.a, x);
      const b = evaluate(node.b, x);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        // Division by zero is a vertical asymptote, not an error: it becomes a gap in the curve.
        case "/": return b === 0 ? NaN : a / b;
        case "%": return b === 0 ? NaN : a % b;
        case "^": return a ** b;
        default: throw new Error(`unknown operator ${node.op}`);
      }
    }
    case "call": {
      const args = node.args.map((a) => evaluate(a, x));
      const nary = NARY[node.name];
      if (nary) return nary.fn(x, args);
      const fn = UNARY[node.name] ?? BINARY[node.name];
      if (!fn) throw new Error(`unknown function ${node.name}`);
      return fn(...args);
    }
  }
}

const usable = (y: number) => Number.isFinite(y) && Math.abs(y) <= MAGNITUDE_LIMIT;

interface Samples {
  /** y at each sample; null where the function is undefined or out of range (a gap in the curve). */
  y: (number | null)[];
  /** Sample indices where a new stroke starts: where the curve comes back into the window. */
  breaks: number[];
  /** The visible y range. Chosen robustly, so one pole cannot flatten the whole graph. */
  yMin: number;
  yMax: number;
  /** Samples where the function is undefined (a hole, as at 1/x's origin). */
  gaps: number;
  /** Samples that are finite but off the top or bottom of the window (a pole, as at tan's). */
  clipped: number;
}

/**
 * Sample the curve over a window, and choose that window the way a graphing calculator does.
 *
 * The window has to ignore the values that run away at a pole -- at tan's the function reaches
 * hundreds while everything interesting sits inside +-1.5, and a min/max window would squeeze the
 * whole graph flat. What counts as "runaway" is judged against the bulk of the samples, with a
 * quartile-and-IQR bound (the standard 1.5-boxplot rule, at 3), so a smooth curve keeps its
 * extremes and only genuine spikes are dropped. Both a fixed percentile and a slope heuristic were
 * tried first: the percentile clips the tips off a parabola, and the slope heuristic chopped tan(x)
 * into 49 fragments near each pole, because a pole is steep over *many* samples.
 *
 * The asymptotes are not detected either, they fall out of the clipping: a sample outside the
 * window is not drawn, so the stroke ends where the curve leaves the top and resumes where it
 * returns. A step function like floor(x) is still drawn with its step, which is correct.
 */
function sample(node: Node, xMin: number, xMax: number, count: number): Samples {
  const y: (number | null)[] = new Array(count);
  const step = (xMax - xMin) / (count - 1);
  let gaps = 0;
  for (let i = 0; i < count; i++) {
    const v = evaluate(node, xMin + i * step);
    y[i] = usable(v) ? v : null;
    if (y[i] === null) gaps++;
  }

  const sorted = y.filter((v): v is number => v !== null).sort((a, b) => a - b);
  let yMin = 0;
  let yMax = 1;
  if (sorted.length) {
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const iqr = at(0.75) - at(0.25);
    // With no spread to judge against -- a constant, or a function taking two values -- there is
    // nothing that looks like an outlier, so the window is simply the data.
    let keep = sorted;
    if (iqr > 0) {
      const lo = at(0.25) - 3 * iqr;
      const hi = at(0.75) + 3 * iqr;
      const trimmed = sorted.filter((v) => v >= lo && v <= hi);
      if (trimmed.length >= 8) keep = trimmed;
    }
    yMin = keep[0];
    yMax = keep[keep.length - 1];
    // A curve that never crosses the axis still gets it, as on a calculator: seeing the sign of
    // the function is most of what a graph is for.
    if (yMin > 0) yMin = 0;
    if (yMax < 0) yMax = 0;
    if (yMax - yMin <= 0) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.05;
    yMin -= pad;
    yMax += pad;
  }

  // Second pass now that the window is known: what falls outside it is not drawn at all.
  const breaks: number[] = [];
  let clipped = 0;
  let outside = false;
  for (let i = 0; i < count; i++) {
    const v = y[i];
    const out = v === null || v < yMin || v > yMax;
    if (v !== null && out) clipped++;
    if (out) outside = true;
    else if (outside) { breaks.push(i); outside = false; }
  }
  return { y, breaks, yMin, yMax, gaps, clipped };
}

// ---------------------------------------------------------------------------------------------
// graph payload
// ---------------------------------------------------------------------------------------------

/** Enough decimals to separate neighbouring samples, and no more: the text is clipped at 6000. */
function decimalsFor(span: number, count: number): number {
  const step = Math.abs(span) / Math.max(1, count - 1);
  return Math.max(2, Math.min(6, Math.ceil(-Math.log10(step || 1)) + 1));
}
const round = (v: number, decimals: number) => Number(v.toFixed(decimals));

/** The payload has to survive the 6000-character clip in chatview.ts, with the report above it. */
const MAX_PAYLOAD = 3400;

/**
 * The curve as the page wants it. Only y values cross the wire -- x is xMin + i*xStep, which the
 * page rebuilds -- so the payload is half the size it would be with pairs, and the x step cannot
 * disagree with the samples. When it will not fit, the curve is thinned and the numbers rounded
 * further rather than truncated: the whole window matters more than the last sample.
 */
function graphPayload(expr: string, xMin: number, xMax: number, count: number, s: Samples, animate: boolean, maxChars: number) {
  const span = xMax - xMin;
  const step = span / (count - 1);
  let ys = s.y;
  let breaks = s.breaks;
  let decimals = decimalsFor(Math.max(span, Math.abs(s.yMax - s.yMin)), count);
  for (;;) {
    const plot = {
      expr,
      xMin: round(xMin, decimals + 2),
      // Enough decimals that xMin + i*xStep still separates neighbouring samples.
      xStep: round(step, decimals + 3),
      yMin: round(s.yMin, decimals),
      yMax: round(s.yMax, decimals),
      y: ys.map((v) => (v === null ? null : round(v, decimals))),
      breaks,
      // Omitted rather than false when it is off: every plot payload pays for this byte.
      ...(animate ? { animate: true } : {}),
    };
    if (JSON.stringify({ artifact: { kind: "graph", plot } }).length <= maxChars || ys.length <= 40) return plot;
    // Too big for the clip: thin the curve out and try again, carrying the breaks across.
    ys = ys.filter((_, i) => i % 2 === 0 || i === ys.length - 1);
    breaks = breaks.filter((i) => i % 2 === 0).map((i) => i >> 1);
    decimals = Math.max(2, decimals - 1);
  }
}

const fmt = (v: number) => {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(1).replace("e+", "e");
  return String(Number(v.toPrecision(6)));
};

// ---------------------------------------------------------------------------------------------
// artifact payload
// ---------------------------------------------------------------------------------------------

interface Artifact {
  kind: "graph" | "html" | "table" | "code" | "image" | "text";
  title: string;
  [key: string]: unknown;
}

const line = (spec: Artifact) => JSON.stringify({ artifact: spec });

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`a ${what} artifact needs ${what === "html" ? "html" : what} to show`);
  return value;
};

/** A file name from a title: lowercase words, nothing a phone's file browser would object to. */
function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "artifact";
}

/** Never overwrite an earlier artifact: an old card in the transcript points at its own file. */
async function uniquePath(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : name.replace(/(\.[a-z0-9]+)?$/, `-${n}$1`));
    if (!(await Bun.file(candidate).exists())) return candidate;
  }
}

/** An image is served from the workspace like everything else, so it has to live there. */
function workspaceRelative(workspace: string, path: string): string {
  const abs = resolve(workspace, path.replace(/^file:\/\//, ""));
  const rel = relative(workspace, abs);
  if (rel.startsWith("..") || rel.startsWith(sep) || resolve(workspace, rel) !== abs) {
    throw new Error(`${path} is outside this session's workspace (${workspace}). Copy the file in there first, then show it.`);
  }
  return rel.split(sep).join("/");
}

// ---------------------------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------------------------

const artifact = defineTool({
  name: "artifact",
  description:
    "Show something in the chat that is meant to be looked at, rather than describing it. " +
    "Tool calls are working and get collapsed into a summary line; an artifact is never folded " +
    "away, because it is the part of the answer the reader is meant to see. Pick a kind: " +
    '"graph" draws a mathematical function of x, the way plot_function did, plus the CSS timing ' +
    "curves (linear, ease, ease_in, ease_out, ease_in_out, cubic_bezier(p1x,p1y,p2x,p2y)); " +
    '"html" writes a self-contained page to the workspace and shows it rendered in a sandboxed ' +
    "frame (no external network, no access to the app); " +
    '"table" shows rows and columns as a real table -- the right shape for a list of results, ' +
    "timings, options or measurements, where prose would either truncate or bury it; " +
    '"code" shows a listing with a language label; "image" shows a picture already in the ' +
    'workspace or one on the web; "text" shows preformatted output worth reading as it stands. ' +
    "Use it whenever the shape of the thing is the point: how many roots a function has, what " +
    "an easing curve does over its duration, what came back from a command, what the diff " +
    "between two options looks like. Then say one or two sentences about it in your reply -- the " +
    "artifact is the picture, the reply is the point of view. Do not use it for something a " +
    "sentence says better.",
  parameters: Type.Object({
    kind: Type.Optional(Type.Union(
      [Type.Literal("graph"), Type.Literal("html"), Type.Literal("table"), Type.Literal("code"), Type.Literal("image"), Type.Literal("text")],
      { description: "What to show. Inferred from the arguments when left out." },
    )),
    title: Type.Optional(Type.String({ description: "A short name for the card, e.g. \"Roots of x^2-4\" or \"Frame budget\"." })),

    // graph
    expr: Type.Optional(Type.String({ description: 'kind "graph": the function of x, e.g. "sin(x)", "x^2 - 4", "1/x", "ease_in_out", "cubic_bezier(0.25,0.1,0.25,1)"' })),
    xMin: Type.Optional(Type.Number({ description: "Left edge of the window (default -10)" })),
    xMax: Type.Optional(Type.Number({ description: "Right edge of the window (default 10)" })),
    samples: Type.Optional(Type.Number({ description: "How many points to sample, 40-600 (default 240)" })),
    animate: Type.Optional(Type.Boolean({
      description: "Run a dot along the curve at a steady speed, looping, jumping where the curve " +
        "leaves the window (default false). Use it when the movement matters more than the shape.",
    })),

    // html
    html: Type.Optional(Type.String({ description: 'kind "html": the whole page, as one self-contained document (inline CSS and script, no external requests).' })),
    height: Type.Optional(Type.Number({ description: "Height of the preview in pixels (default 380)" })),

    // table
    columns: Type.Optional(Type.Array(Type.String(), { description: 'kind "table": the column headings, left to right.' })),
    rows: Type.Optional(Type.Array(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()])), { description: "kind \"table\": one array of cells per row." })),

    // code / text
    code: Type.Optional(Type.String({ description: 'kind "code" or "text": what to show, verbatim.' })),
    language: Type.Optional(Type.String({ description: 'kind "code": a label for it, e.g. "ts", "html", "diff".' })),

    // image
    path: Type.Optional(Type.String({ description: 'kind "image": a file in this session\'s workspace, relative to it.' })),
    url: Type.Optional(Type.String({ description: 'kind "image": an http(s) image URL.' })),
  }),
  // The chat view reads this (see extensions.ts): the body is the card rather than the arguments,
  // and standalone keeps it out of the collapsed run of calls it sits between.
  view: { icon: "sparkles", body: "artifact", summaryArg: "title", standalone: true, hideOutput: true },
  execute: async (args, api) => {
    const kind = typeof args.kind === "string" ? args.kind
      : args.expr !== undefined ? "graph"
      : args.html !== undefined ? "html"
      : args.columns !== undefined || args.rows !== undefined ? "table"
      : args.code !== undefined ? "code"
      : args.url !== undefined || args.path !== undefined ? "image"
      : "text";
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 120) : "";
    const workspace = workspaceDir(api.conversationId);

    if (kind === "graph") {
      const expr = text(args.expr, "graph");
      const node = compile(expr);
      const xMin = args.xMin ?? -10;
      const xMax = args.xMax ?? 10;
      if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) throw new Error("xMin and xMax must be finite numbers");
      if (xMax <= xMin) throw new Error(`xMax (${xMax}) must be greater than xMin (${xMin})`);
      const span = xMax - xMin;
      if (span > 1e7) throw new Error(`that window is ${fmt(span)} wide; keep it under 1e7 or the curve turns into noise`);

      const count = Math.max(40, Math.min(600, Math.round(args.samples ?? 240)));
      const t0 = performance.now();
      const s = sample(node, xMin, xMax, count);
      const plot = graphPayload(expr.trim(), xMin, xMax, count, s, !!args.animate, MAX_PAYLOAD);
      // Not "asymptotes": what is counted is the number of times the curve leaves the window and
      // comes back, which for abs(sin(3x))/x^2 is several runs round one spike and for a function
      // with no asymptotes at all can still be zero. The wording says what happened.
      const runs = s.breaks.length;
      const spec: Artifact = { kind: "graph", title: title || `y = ${expr.trim()}`, expr: expr.trim(), plot };
      const report = [
        `Graph: y = ${expr.trim()}`,
        `  x in [${fmt(xMin)}, ${fmt(xMax)}]  ·  y in [${fmt(s.yMin)}, ${fmt(s.yMax)}]`,
        `  ${count} samples · ${s.clipped} point${s.clipped === 1 ? "" : "s"} off the graph in ${runs} run${runs === 1 ? "" : "s"} · ${s.gaps} undefined · ${(performance.now() - t0) | 0}ms`,
        args.animate ? `  animation: a dot runs the curve at a steady speed${runs ? `, jumping ${runs} time${runs === 1 ? "" : "s"} where it leaves the window` : ""}` : "",
      ].filter(Boolean).join("\n");
      api.output(`${report}\n${line(spec)}`);
      return { kind: "graph", expr: spec.expr, domain: [xMin, xMax], range: [s.yMin, s.yMax], clippedRuns: runs };
    }

    if (kind === "html") {
      const html = text(args.html, "html");
      const name = `${slug(title || "page")}.html`;
      const dir = join(workspace, ARTIFACT_DIR);
      await mkdir(dir, { recursive: true });
      const file = await uniquePath(dir, name);
      await Bun.write(file, html);
      const path = `${ARTIFACT_DIR}/${file.split(sep).pop()}`;
      const spec: Artifact = { kind: "html", title: title || path, path, height: Number(args.height) || 380 };
      api.output(`Page: ${title || path} (${html.length} bytes, ${path})\n${line(spec)}`);
      return { kind: "html", path, bytes: html.length };
    }

    if (kind === "table") {
      const columns = Array.isArray(args.columns) ? args.columns.map((c) => String(c).slice(0, 80)) : [];
      const all = Array.isArray(args.rows) ? args.rows : [];
      if (!all.length) throw new Error("a table artifact needs rows");
      const rows = all.slice(0, MAX_ROWS).map((row) => (Array.isArray(row) ? row : [row]).map((cell) => {
        if (typeof cell === "number" || typeof cell === "boolean") return cell;
        return String(cell ?? "").slice(0, MAX_CELL);
      }));
      const spec: Artifact = { kind: "table", title: title || "Table", columns, rows };
      const dropped = all.length - rows.length;
      api.output(
        `Table: ${rows.length} row${rows.length === 1 ? "" : "s"}${columns.length ? ` × ${columns.length} columns` : ""}` +
        `${dropped ? ` (${dropped} more row${dropped === 1 ? "" : "s"} did not fit and were left out)` : ""}\n${line(spec)}`,
      );
      return { kind: "table", rows: rows.length, columns: columns.length, truncated: dropped };
    }

    if (kind === "image") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (url) {
        if (!/^https?:\/\//i.test(url)) throw new Error(`an image url must be http(s), got ${JSON.stringify(url)}`);
        const spec: Artifact = { kind: "image", title: title || url, src: url };
        api.output(`Image: ${url}\n${line(spec)}`);
        return { kind: "image", src: url };
      }
      const path = workspaceRelative(workspace, text(args.path, "image"));
      const spec: Artifact = { kind: "image", title: title || path, path };
      api.output(`Image: ${path}\n${line(spec)}`);
      return { kind: "image", path };
    }

    // code, text
    const body = text(args.code, "code");
    const kindCode = kind === "code";
    const spec: Artifact = {
      kind: kindCode ? "code" : "text",
      title: title || (typeof args.language === "string" && args.language ? args.language : kindCode ? "Code" : "Output"),
      text: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n… ${body.length - MAX_TEXT} more characters` : body,
      ...(kindCode && typeof args.language === "string" && args.language ? { language: args.language.slice(0, 24) } : {}),
    };
    api.output(`${spec.title}: ${body.length} characters\n${line(spec)}`);
    return { kind: spec.kind, title: spec.title, characters: body.length };
  },
});

/* ------------------------------------------------------------------ *
 * prompt section
 * ------------------------------------------------------------------ */

const ARTIFACTS = section(
  "artifacts",
  () =>
    "The transcript collapses runs of tool calls into one line -- that is where commands, reads, " +
    "searches and edits belong. When the reader is meant to *see* something, use the artifact " +
    "tool instead: it is rendered in the open and never folded away. That means a graph of a " +
    "function or a CSS timing curve, a table of results, timings or options, a self-contained " +
    "HTML page, an image, or a listing that would be unreadable inline. Give it a short title, " +
    "then say one or two sentences about what it shows -- the artifact is the picture, your " +
    "reply is the point of view.",
);

export default defineExtension({
  name: "artifact",
  tools: [artifact],
  sections: [ARTIFACTS],
});
