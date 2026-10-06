/**
 * plot: draw a mathematical function in the chat view.
 *
 * The agent calls plot_function with an expression in x ("sin(x)", "x^2 - 4", "1/x",
 * "abs(sin(3x))/x^2"); the chat view shows the curve instead of a JSON dump of the arguments.
 *
 * How the drawing gets there, and why it is built this way:
 *
 *  - The tool view system (extensions.ts) is declarative on purpose: a view picks a renderer that
 *    already exists in the page, because an extension's code cannot be shipped into the WebView.
 *    "plot" is such a renderer -- a small addition to www/chat.js, like the diff and result-card
 *    previews that were there first.
 *
 *  - The page never evaluates the expression. Evaluating model-authored text in the WebView would
 *    be a script-injection hole with a very short fuse, so the curve is sampled HERE, in the
 *    extension, and only numbers cross the wire. The page's whole job is to map those numbers onto
 *    an SVG polyline and draw grid lines.
 *
 *  - Nothing here uses eval() or new Function() either. The expression is tokenised and parsed
 *    into a small tree that is walked by hand, so a hostile expression costs a parse error
 *    instead of the sandbox: no loops, no property access, no way to reach Bun. Only x, the
 *    constants and the function table below exist as names.
 *
 *  - The samples travel as the last line of the tool's own output -- a {"plot":...} JSON payload,
 *    the same trick web_search uses with its result cards. The UI gets exactly what the model
 *    gets, and there is no second format to keep in step with the first. It has to stay small:
 *    chatview.ts clips tool text at 6000 characters, so the y values are rounded and the sample
 *    count is halved until the payload fits.
 *
 * The optional animate flag adds a dot running along the curve from the left of the window to the
 * right, which is the way to see how something *moves* over a curve rather than what it looks
 * like -- an easing or tween curve, a value decaying over time. The dot keeps one steady speed and
 * jumps where the curve leaves the window, because that jump is part of what the graph is showing.
 * How long the traverse takes is the page's business: it knows the size of the box it is drawing
 * into and this side does not, so all that crosses the wire is the flag.
 *
 * After editing, call reload_extensions. No restart needed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

// ---------------------------------------------------------------------------------------------
// tokenizer
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
    if (t.kind === "(") {
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
export function compile(src: string): Node {
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

export function evaluate(node: Node, x: number): number {
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

export interface Samples {
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
export function sample(node: Node, xMin: number, xMax: number, count: number): Samples {
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
// payload
// ---------------------------------------------------------------------------------------------

/** Enough decimals to separate neighbouring samples, and no more: the text is clipped at 6000. */
function decimalsFor(span: number, count: number): number {
  const step = Math.abs(span) / Math.max(1, count - 1);
  return Math.max(2, Math.min(6, Math.ceil(-Math.log10(step || 1)) + 1));
}
const round = (v: number, decimals: number) => Number(v.toFixed(decimals));

/**
 * The {"plot":...} line. Only y values cross the wire -- x is xMin + i*xStep, which the page
 * rebuilds -- so the payload is half the size it would be with pairs, and the x step cannot
 * disagree with the samples.
 */
function payload(expr: string, xMin: number, xMax: number, count: number, s: Samples, animate: boolean, maxChars: number): string {
  const span = xMax - xMin;
  const step = span / (count - 1);
  let ys = s.y;
  let breaks = s.breaks;
  let decimals = decimalsFor(Math.max(span, Math.abs(s.yMax - s.yMin)), count);
  for (;;) {
    const y = ys.map((v) => (v === null ? null : round(v, decimals)));
    const line = JSON.stringify({
      plot: {
        expr,
        xMin: round(xMin, decimals + 2),
        // Enough decimals that xMin + i*xStep still separates neighbouring samples.
        xStep: round(step, decimals + 3),
        yMin: round(s.yMin, decimals),
        yMax: round(s.yMax, decimals),
        y,
        breaks,
        // Omitted rather than false when it is off: every plot payload pays for this byte.
        ...(animate ? { animate: true } : {}),
      },
    });
    if (line.length <= maxChars || ys.length <= 40) return line;
    // Too big for the clip: thin the curve out and try again, carrying the breaks across.
    ys = ys.filter((_, i) => i % 2 === 0 || i === ys.length - 1);
    breaks = breaks.filter((i) => i % 2 === 0).map((i) => i >> 1);
    decimals = Math.max(2, decimals - 1);
  }
}

/** The payload has to survive the 6000-character clip in chatview.ts, with the report above it. */
const MAX_PAYLOAD = 3800;

const fmt = (v: number) => {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(1).replace("e+", "e");
  return String(Number(v.toPrecision(6)));
};

// ---------------------------------------------------------------------------------------------
// tool
// ---------------------------------------------------------------------------------------------

const plotFunction = defineTool({
  name: "plot_function",
  description:
    "Draw a graph of a mathematical function of x in the chat view. Use it whenever a graph says " +
    "something a table or a formula does not: shapes and intersections, how many roots a function " +
    "has, where it is increasing, whether two curves cross, what an asymptote does. The " +
    "expression is parsed, not evaluated as code: + - * / % ^ and parentheses, implicit " +
    "multiplication (2x, 3pi, 2(x+1)), the variable x, the constants pi, tau and e, and the " +
    "functions " + FUNCTION_NAMES + " (log is the natural logarithm). It also knows the CSS timing " +
    "curves -- use them bare, as in CSS: " + CURVE_NAMES + ", or cubic_bezier(p1x, p1y, p2x, p2y) " +
    "for any other timing function, to see how a CSS transition or animation moves over its " +
    "duration. The y window is chosen so one " +
    "spike cannot flatten the graph, and a sample that falls outside it is not drawn: poles, jumps " +
    "such as 1/x and undefined points all come out as gaps rather than lines up the side. " +
    "Pass animate to also run a dot along the curve with a trail behind it, at a steady speed and " +
    "jumping at the gaps -- the way to show how something moves over a curve (a point traversing " +
    "it, a value oscillating) when its shape alone does not say it.",
  parameters: Type.Object({
    expr: Type.String({ description: "The function of x, e.g. \"sin(x)\", \"x^2 - 4\", \"1/x\", \"abs(sin(3x))/x^2\"" }),
    xMin: Type.Optional(Type.Number({ description: "Left edge of the window (default -10)" })),
    xMax: Type.Optional(Type.Number({ description: "Right edge of the window (default 10)" })),
    samples: Type.Optional(Type.Number({ description: "How many points to sample, 40-600 (default 240)" })),
    animate: Type.Optional(Type.Boolean({
      description: "Run a dot from the left of the window to the right at a steady speed, looping, " +
        "jumping where the curve leaves the window (default false). Use when the movement matters " +
        "more than the shape -- an easing or tween curve, a value decaying over time.",
    })),
  }),
  // The chat view reads this (see extensions.ts): the row shows the expression, opens by default,
  // and its body is the curve rather than the arguments.
  view: { icon: "activity", body: "plot", summaryArg: "expr", open: true, label: "graph" },
  execute: async (args, api) => {
    const node = compile(args.expr);
    const xMin = args.xMin ?? -10;
    const xMax = args.xMax ?? 10;
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) throw new Error("xMin and xMax must be finite numbers");
    if (xMax <= xMin) throw new Error(`xMax (${xMax}) must be greater than xMin (${xMin})`);
    const span = xMax - xMin;
    if (span > 1e7) throw new Error(`that window is ${fmt(span)} wide; keep it under 1e7 or the curve turns into noise`);

    const count = Math.max(40, Math.min(600, Math.round(args.samples ?? 240)));
    const t0 = performance.now();
    const s = sample(node, xMin, xMax, count);
    const line = payload(args.expr.trim(), xMin, xMax, count, s, !!args.animate, MAX_PAYLOAD);

    // Not "asymptotes": what is counted is the number of times the curve leaves the window and
    // comes back, which for a function like abs(sin(3x))/x^2 is several runs round one spike and
    // for a function with no asymptotes at all can still be zero. The wording says what happened.
    const runs = s.breaks.length;
    const report = [
      `y = ${args.expr.trim()}`,
      `  x in [${fmt(xMin)}, ${fmt(xMax)}]  ·  y in [${fmt(s.yMin)}, ${fmt(s.yMax)}]`,
      `  ${count} samples · ${s.clipped} point${s.clipped === 1 ? "" : "s"} off the graph in ${runs} run${runs === 1 ? "" : "s"} · ${s.gaps} undefined · ${(performance.now() - t0) | 0}ms`,
      args.animate ? `  animation: a dot runs the curve at a steady speed${runs ? `, jumping ${runs} time${runs === 1 ? "" : "s"} where it leaves the window` : ""}` : "",
      line,
    ].filter(Boolean).join("\n");
    api.output(report);
    return {
      expr: args.expr.trim(),
      domain: [xMin, xMax],
      range: [s.yMin, s.yMax],
      animated: !!args.animate,
      clippedRuns: runs,
      offGraph: s.clipped,
      undefinedPoints: s.gaps,
    };
  },
});

export default defineExtension({
  name: "plot",
  tools: [plotFunction],
});
