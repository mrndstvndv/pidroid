// Artifacts: the things the agent puts in the transcript on purpose.
//
// Everything else in a turn -- commands, reads, searches -- is working, and the chat view sums a
// run of it up to one collapsed line ("Ran 5 commands, read a file") that expands on demand. An
// artifact is the opposite: something the agent made *for* the reader to look at. A graph of a
// function, a rendered page, a table of results, an image, a code listing worth more than a
// sentence. It is never folded into a group and never collapsed, because it is not a step towards
// the answer -- it is the answer's other half.
//
// The payload arrives the same way web_search's cards and the old plot payload did: as the last
// line of the tool's own output, a {"artifact":{...}} JSON object. The page gets exactly what the
// model gets, so there is no second format to keep in step with the first, and a payload that will
// not parse costs the drawing rather than the record -- the caller falls back to the raw text.
//
// Nothing here evaluates the expression of a graph: extensions/artifact.ts samples the curve
// server-side and only numbers cross the wire, so this file maps samples to pixels and does
// nothing else. An HTML artifact is written to the session workspace by the same extension and is
// shown through the workspace URL, inside an iframe with no allow-same-origin: it can run, and it
// cannot reach the app. Like the Artifacts screen, it is a separate file rather than markup in
// this document, because a model-authored page has no business inside the page that holds the
// user's session.

(function () {

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The {"artifact":{...}} line an artifact tool left at the end of its output, or null. */
function payloadFrom(output, key = "artifact") {
  const lines = String(output ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(`{"${key}":`)) continue;
    try {
      const parsed = JSON.parse(lines[i])[key];
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* fall through: the raw text is still the record */ }
  }
  return null;
}

/* ---------- graphs ----------

   A curve, drawn from samples rather than from an expression: the extension tokenised and
   evaluated the expression itself, and what crossed the wire is a list of y values. The x values
   are not even sent -- xStep and xMin rebuild them -- which halves the payload and makes it
   impossible for the two to disagree.

   Anything that does not parse, or parses into something implausible, returns "" and the caller
   falls back to the raw output: a malformed payload can cost the drawing, never the record. */

const PLOT_W = 640;
const PLOT_H = 300;
const PLOT_PAD = { left: 48, right: 16, top: 16, bottom: 30 };
/** More points than this and the DOM, not the maths, is the bottleneck. */
const PLOT_MAX_POINTS = 1600;
/** How fast the animated dot travels, in graph units (the 640-wide viewBox) per second. */
const PLOT_SPEED = 70;
/** Makes the path ids unique: two graphs on one page would otherwise share #plot-s0, and an
 *  <mpath> would send the second one's dot along the first one's curve. */
let plotSeq = 0;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** A round-ish step (1, 2, 5 x 10^n) that lands near `target` intervals across [lo, hi]. */
function niceStep(span, target) {
  const raw = Math.abs(span) / Math.max(1, target);
  if (!isNum(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const pow = 10 ** exp;
  for (const f of [1, 2, 5, 10]) if (raw <= f * pow) return f * pow;
  return 10 * pow;
}

/** Tick labels: exact enough to read, short enough to fit under the axis. */
function fmtTick(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(0).replace("e+", "e");
  return String(Number(v.toPrecision(4)));
}

function plotTicks(lo, hi, target) {
  const step = niceStep(hi - lo, target);
  if (!isNum(step) || step <= 0) return [];
  const out = [];
  // A step that is a rounding error against the window would loop forever; the guard is the cap.
  for (let v = Math.ceil(lo / step) * step, i = 0; v <= hi + step * 1e-6 && i < 24; v += step, i++) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/** The {"plot":...} payload of the old plot_function tool, for transcripts that still carry one. */
function plotFromOutput(output) {
  const p = payloadFrom(output, "plot");
  return p ? graphHtml(p, false) : "";
}

/**
 * The curve itself. `live` is true while the call is still running, which is what stops it
 * animating: the list is rebuilt on every push of a streaming run and SMIL would start over each
 * time, which looks frozen rather than animated.
 */
function graphHtml(p, live = false) {
  if (!p || typeof p !== "object") return "";
  if (!isNum(p.xMin) || !isNum(p.xStep) || p.xStep === 0 || !isNum(p.yMin) || !isNum(p.yMax)) return "";
  if (!Array.isArray(p.y) || p.y.length < 2 || p.yMax <= p.yMin) return "";
  const expr = typeof p.expr === "string" ? p.expr : "";
  if (p.y.some((v) => v !== null && !isNum(v))) return "";
  const breaks = Array.isArray(p.breaks) ? p.breaks.filter((i) => Number.isInteger(i) && i > 0 && i < p.y.length) : [];

  let ys = p.y;
  let brk = breaks;
  if (ys.length > PLOT_MAX_POINTS) {
    // Thin rather than truncate: the whole window matters more than the last sample.
    const keep = (i) => i % 2 === 0 || i === ys.length - 1;
    ys = ys.filter((_, i) => keep(i));
    brk = brk.filter((i) => keep(i)).map((i) => Math.floor(i / 2));
  }

  const left = PLOT_PAD.left;
  const top = PLOT_PAD.top;
  const width = PLOT_W - PLOT_PAD.left - PLOT_PAD.right;
  const height = PLOT_H - PLOT_PAD.top - PLOT_PAD.bottom;
  const last = ys.length - 1;
  const px = (i) => left + (i / last) * width;
  const py = (v) => top + (1 - (v - p.yMin) / (p.yMax - p.yMin)) * height;
  const r1 = (n) => Math.round(n * 10) / 10;
  const xOf = (i) => p.xMin + i * p.xStep;

  const grid = [];
  for (const t of plotTicks(p.xMin, xOf(last), 5)) {
    const x = r1(px((t - p.xMin) / p.xStep));
    grid.push(`<line class="plot-grid" x1="${x}" y1="${top}" x2="${x}" y2="${top + height}" />`);
    grid.push(`<text class="plot-tick" x="${x}" y="${top + height + 14}" text-anchor="middle">${esc(fmtTick(t))}</text>`);
  }
  for (const t of plotTicks(p.yMin, p.yMax, 4)) {
    const y = r1(py(t));
    grid.push(`<line class="plot-grid" x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" />`);
    grid.push(`<text class="plot-tick" x="${left - 6}" y="${y + 3}" text-anchor="end">${esc(fmtTick(t))}</text>`);
  }

  // The axes are drawn only where they fall inside the window, and heavier than the grid.
  const axes = [];
  if (p.yMin < 0 && p.yMax > 0) {
    const y = r1(py(0));
    axes.push(`<line class="plot-axis" x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" />`);
  }
  if (p.xMin < 0 && xOf(last) > 0) {
    const x = r1(px((0 - p.xMin) / p.xStep));
    axes.push(`<line class="plot-axis" x1="${x}" y1="${top}" x2="${x}" y2="${top + height}" />`);
  }

  // One stroke per continuous run of the curve, kept as point lists until the markup is built:
  // a null sample, a sample outside the window and a marked break all end a stroke, so a pole is a
  // gap reaching the edge of the graph rather than a line up its side. The points are needed as
  // numbers first because the animation measures each stroke's arc length before drawing it.
  const stops = new Set(brk);
  const segments = [];
  let seg = [];
  const flush = () => {
    if (seg.length > 1) segments.push(seg);
    seg = [];
  };
  for (let i = 0; i < ys.length; i++) {
    const v = ys[i];
    if (v === null || v < p.yMin || v > p.yMax || stops.has(i)) { flush(); continue; }
    seg.push([r1(px(i)), r1(py(v))]);
  }
  flush();

  const d = (pts) => pts.map(([x, y], k) => `${k ? "L" : "M"}${x} ${y}`).join(" ");
  const uid = `plot${++plotSeq}`;
  const paths = segments.map((pts, i) => `<path id="${uid}-s${i}" class="plot-curve" d="${d(pts)}" />`);

  /* p.animate runs a single dot along the curve, from the left of the window to the right.

     SMIL rather than CSS, deliberately. The dot has to follow the curve in the SVG's own user
     units, so it stays glued to the line whatever width the graph is drawn at; CSS offset-path
     would be working in CSS pixels on an SVG element, which is unevenly supported and drifts off
     the curve as the graph scales. SMIL moves along a path in user units natively.

     One dot per stroke, each offset to start at its share of the arc length, so the dot keeps one
     steady speed across strokes instead of racing through a short branch and crawling along a long
     one. Each repeats, so it loops for as long as the card is on screen. Where the curve leaves
     the window the dot jumps to the next stroke -- the same jump the curve makes, rather than one
     smoothed over a gap the graph is trying to show. */
  let motion = "";
  if (p.animate && !live && segments.length) {
    const lengths = segments.map((pts) =>
      pts.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0),
    );
    const total = lengths.reduce((a, b) => a + b, 0);
    const dur = Math.min(14, Math.max(2.5, total / PLOT_SPEED)).toFixed(2);
    const bits = [];
    let passed = 0;
    segments.forEach((pts, i) => {
      const begin = total && passed ? ` begin="-${((passed / total) * Number(dur)).toFixed(2)}s"` : "";
      passed += lengths[i];
      bits.push(
        `<circle class="plot-dot" r="3.5">` +
          `<animateMotion dur="${dur}s"${begin} repeatCount="indefinite" rotate="auto">` +
          `<mpath href="#${uid}-s${i}" xlink:href="#${uid}-s${i}" />` +
          `</animateMotion>` +
          `</circle>`,
      );
    });
    motion = bits.join("");
  }

  const caption = expr ? `y = ${esc(expr)}` : "graph";
  const alt = `${caption}, x from ${fmtTick(p.xMin)} to ${fmtTick(xOf(last))}, y from ${fmtTick(p.yMin)} to ${fmtTick(p.yMax)}`;
  return (
    `<div class="plot">` +
    `<svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" role="img" aria-label="${esc(alt)}" preserveAspectRatio="xMidYMid meet">` +
    grid.join("") + axes.join("") + paths.join("") + motion +
    `</svg>` +
    `<div class="plot-cap">${caption}<span class="plot-range">${esc(fmtTick(p.xMin))} … ${esc(fmtTick(xOf(last)))}</span></div>` +
    `</div>`
  );
}

/* ---------- the card ---------- */

const KIND_ICON = {
  graph: "activity",
  html: "file-text",
  code: "code",
  table: "list-todo",
  image: "file",
  text: "message-square",
};

/** Workspace-relative path -> the URL the server serves it under. */
function workspaceUrl(path, sessionId) {
  const clean = String(path || "").replace(/^\/+/, "");
  return `/workspace/${sessionId}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

const isHttp = (u) => /^https?:\/\//i.test(u);

/** A cell is rendered as text, always: it comes from the model, and this is the app's own DOM. */
function cell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return esc(String(v));
}

/** Renders one payload as a card, or "" when the payload is not one this page understands. */
function cardBody(spec, sessionId, live) {
  switch (spec.kind) {
    case "graph":
      return graphHtml(spec.plot || spec, live);
    case "html": {
      // A page the model wrote, in a frame that cannot touch this one: no allow-same-origin, so
      // it runs in an opaque origin and cannot read the session out of the app around it.
      const height = Math.min(720, Math.max(180, Number(spec.height) || 380));
      return `<iframe class="artifact-page" style="height:${height}px" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="${esc(workspaceUrl(spec.path, sessionId))}"></iframe>`;
    }
    case "code":
    case "text": {
      const text = String(spec.text ?? "");
      const shown = text.length > 20000 ? `${text.slice(0, 20000)}\n… ${text.length - 20000} more characters` : text;
      return `<pre class="code artifact-code">${esc(shown)}</pre>`;
    }
    case "table": {
      const columns = Array.isArray(spec.columns) ? spec.columns : [];
      const rows = Array.isArray(spec.rows) ? spec.rows : [];
      const head = columns.length
        ? `<thead><tr>${columns.map((c) => `<th>${cell(c)}</th>`).join("")}</tr></thead>`
        : "";
      const body = rows.map((row) => {
        const cells = Array.isArray(row) ? row : [row];
        return `<tr>${cells.map((v) => `<td>${cell(v)}</td>`).join("")}</tr>`;
      }).join("");
      if (!columns.length && !rows.length) return `<p class="artifact-note">The table is empty.</p>`;
      return `<div class="artifact-table-wrap"><table class="artifact-table">${head}<tbody>${body}</tbody></table></div>`;
    }
    case "image": {
      const src = isHttp(spec.src) ? String(spec.src) : workspaceUrl(spec.path ?? spec.src, sessionId);
      if (!src) return "";
      return `<div class="artifact-figure"><img src="${esc(src)}" alt="${esc(spec.title || "artifact")}" loading="lazy" /></div>`;
    }
    default:
      return "";
  }
}

/**
 * The whole card: a header with the title and the actions, then the thing itself.
 *
 * The header is not a collapse control. An artifact is already out of the way of the collapsed
 * tool rows; making its own body fold away would only put it back in the same category.
 */
function artifactCard(spec, { sessionId, live = false } = {}) {
  const kind = String(spec.kind || "");
  const body = cardBody(spec, sessionId, live);
  if (!body) return "";
  const title = String(spec.title || spec.path || kind);
  const iconName = KIND_ICON[kind] || "sparkles";
  // Everything the buttons need later, and nothing they do not: the payload itself stays out of
  // the DOM, so a 20 KB listing is not also a 20 KB attribute on the element showing it.
  const path = typeof spec.path === "string" ? spec.path : "";
  const attrs =
    `data-kind="${esc(kind)}" data-session="${esc(sessionId ?? "")}"` +
    (path ? ` data-path="${esc(path)}"` : "") +
    (spec.language ? ` data-language="${esc(spec.language)}"` : "");
  const meta = [spec.language || "", spec.expr && kind === "graph" ? spec.expr : ""].filter(Boolean).join(" · ");
  // Open for the things with somewhere to open: a page written to the workspace. Copy for the
  // things that are text at heart -- a listing, a table's cells. Labelled rather than glyphed, the
  // way the code blocks in the transcript label their copy button. The click handler below is
  // delegated and works off data-act, so a card rebuilt by a streaming update needs no handlers.
  const acts = [];
  if (path && kind === "html")
    acts.push(`<button type="button" class="artifact-act" data-act="open" title="Open full screen">Open</button>`);
  if (kind !== "graph" && kind !== "image")
    acts.push(`<button type="button" class="artifact-act" data-act="copy" title="Copy">Copy</button>`);
  const actions = acts.join("");

  return (
    `<div class="artifact" ${attrs}>` +
    `<div class="artifact-head">` +
      `<span class="artifact-ico">${icon(iconName, 14)}</span>` +
      `<span class="artifact-title">${esc(title)}</span>` +
      `<span class="artifact-meta">${esc(meta)}</span>` +
      `<span class="artifact-actions">${actions}</span>` +
    `</div>` +
    `<div class="artifact-body">${body}</div>` +
    `</div>`
  );
}

/* ---------- actions ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs a secure context and a user gesture; the textarea is the old way
    // round, and it is the only one left when the WebView refuses the first.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* nothing more to try */ }
    ta.remove();
    return ok;
  }
}

/**
 * One delegated listener on the document, so a card rebuilt by a streaming update needs no
 * handlers of its own: the buttons are found by their data-act, from the card they sit in.
 */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest?.(".artifact-act");
  if (!btn) return;
  const card = btn.closest(".artifact");
  if (!card) return;

  if (btn.dataset.act === "open") {
    window.showScreen?.("artifacts");
    window.openWorkspaceFile?.(card.dataset.path);
    return;
  }
  // The source is whatever the card is made of: the listing on screen, or the file it is showing.
  const pre = card.querySelector(".artifact-code");
  let text = pre?.textContent ?? null;
  if (text === null && card.dataset.kind === "table") {
    // A table has no pre: its cells are the text, read row by row so a paste lands as columns.
    const rows = [...card.querySelectorAll(".artifact-table tr")].map((tr) =>
      [...tr.children].map((cell) => cell.textContent.trim()).join("\t"));
    if (rows.length) text = rows.join("\n");
  }
  if (text === null && card.dataset.path && card.dataset.session) {
    try {
      const res = await fetch(workspaceUrl(card.dataset.path, card.dataset.session));
      if (res.ok) text = await res.text();
    } catch { /* falls through to the no-op below */ }
  }
  if (text === null) return;
  const ok = await copyText(text);
  if (!ok) return;
  btn.classList.add("done");
  setTimeout(() => btn.classList.remove("done"), 1200);
});

/* ---------- exports ---------- */

window.artifactCard = artifactCard;
/* Also under one name, because a classic script's top-level function declaration anywhere on the
   page can land on top of a single global -- which is exactly what happened to `artifactCard`
   above. A namespaced object cannot be shadowed by accident. */
window.artifactRenderer = { card: artifactCard, payloadFrom };
window.graphFromPlotPayload = plotFromOutput;
window.graphHtml = graphHtml;
window.artifactPayloadFrom = payloadFrom;

})();
