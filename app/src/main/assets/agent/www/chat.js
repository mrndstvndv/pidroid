// Chat: renders the live agent view (streaming thinking, tool calls, queue, context + cache stats).
// The server sends a full snapshot for commits and a compact live-tail patch while streaming.

const messagesEl = document.getElementById("messages-container");
const jumpBottomBtn = document.getElementById("chat-jump-bottom");
// Keep the committed transcript and the streaming tail in separate flattened flex groups. A
// token update can then replace the tail without tearing down or reparsing the history.
const historyEl = document.createElement("div");
historyEl.className = "chat-message-history";
const dynamicEl = document.createElement("div");
dynamicEl.className = "chat-message-live";
messagesEl.replaceChildren(historyEl, dynamicEl);
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const queueBar = document.getElementById("queue-bar");
const ctxLabel = document.getElementById("ctx-label");
const ctxFill = document.getElementById("ctx-fill");
const cacheLabel = document.getElementById("cache-label");
const ctxPct = document.getElementById("ctx-pct");
const ctxPill = document.getElementById("ctx-pill");
const costLabel = document.getElementById("cost-label");
const thinkingSelect = document.getElementById("thinking-select");

// Sections the user opened / closed by hand, keyed by data-key; everything else follows the defaults.
const userOpen = new Set();
const userClosed = new Set();

let payload = null;
let lastModel = "";
let lastQueueCount = -1;
let frame = 0;
let renderedSessionId = null;
let lastHistoryKey = null;
let historyHasContent = false;
let statsDirty = true;

/* ---------- copy buttons on code blocks ----------
   The markdown is rendered by the server, so the buttons are added here in the page rather than
   in the renderer: the transcript is rebuilt from innerHTML on every commit, and a wrapper that
   survives only as long as its block would drop its button mid-read. Re-running this after each
   rebuild is a few nodes, and `done` markers keep it to a single pass per block.

   Only the markdown code boxes inside a message body qualify. Tool bodies and diffs are excluded:
   a diff has no single meaningful "code" to copy, and its own chrome already offers actions. */
function enhanceCodeBlocks(root) {
  if (!root) return;
  for (const pre of root.querySelectorAll(".message-content pre")) {
    if (pre.dataset.copyReady === "1" || pre.closest(".tool-body, .tool-diff, .diff")) continue;
    pre.dataset.copyReady = "1";
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.replaceWith(wrap);
    wrap.append(pre);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.dataset.act = "copy-code";
    button.setAttribute("aria-label", "Copy code");
    button.innerHTML = `<span class="code-copy-label">Copy</span>`;
    wrap.append(button);
  }
}

/** Clipboard API first; the textarea path is what works in a WebView that refuses the async one. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the synchronous route below.
  }
  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

// One delegated listener: the buttons are thrown away and rebuilt with the transcript, so a
// listener per button would leak one per commit.
document.addEventListener("click", async (event) => {
  const button = event.target.closest?.(".code-copy");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const pre = button.parentElement?.querySelector("pre");
  if (!pre) return;
  const label = button.querySelector(".code-copy-label");
  const ok = await copyText(pre.innerText);
  if (label) label.textContent = ok ? "Copied" : "Failed";
  button.classList.toggle("copied", ok);
  clearTimeout(button.resetTimer);
  button.resetTimer = setTimeout(() => {
    if (label) label.textContent = "Copy";
    button.classList.remove("copied");
  }, 1600);
});
let controlsDirty = true;
let lastSessionInfo = "";

// The live tail is refreshed during streaming, so the shimmer text and tool spinner are
// new elements each time and their CSS animation would restart from 0 — with a streaming
// update arriving many times a second the cycle never completes and the animation looks
// frozen. The phase below is stamped on the container (which survives the re-render) and
// style.css turns it into a negative animation-delay, so every fresh element resumes the
// cycle where the previous one was. It must never wrap: a wrap point that is not a whole
// number of cycles (0.8s spin, 1.6s shimmer) would jump the animation.
const ANIM_PHASE_STEP = 0.05; // s; anything well under a frame looks continuous
let lastPhase = "";

/* ---------- streaming text ----------
   Streamed text renders in one piece, at full opacity: the live tail is rebuilt each frame, so
   anything that tracked a character's age would need per-character inline styles on every
   pass. A long thought instead fades at the edges of its box (`.think-body.overflowing`
   in style.css), which survives the re-render because it is plain CSS on the container.
   Rendering in one piece also means a markdown construct written across several frames is
   no longer cut in half mid-parse. */

/* ---------- smooth scrolling ----------
   Streaming rewrites this list several times a second, and pinning scrollTop to the new
   bottom on every one of those passes reads as a string of jolts rather than as motion.
   These helpers glide instead, with one filter for every case: a critically damped spring
   (SmoothDamp's closed form). Two properties are what make it read as smooth.

   It starts at rest and eases in. An exponential follow — the obvious first choice — has
   infinite acceleration at t=0: the instant a new bit of text lands, the view jumps
   straight to full speed. A damped spring ramps into motion instead, and settles without
   ever overshooting, so there is no "arrived, correct, overshot, come back" at the end.

   It carries velocity between passes. This is the one that matters here, and it is why the
   state is keyed by block key rather than by node: the live tail is rebuilt from innerHTML on
   every stream update, so a thinking body is a *different element* each time. Keyed by node, the
   filter restarted from rest on every pass and the view moved in a visible stutter several
   times a second — position survived the rebuild, velocity did not, and velocity is what
   motion is. Keyed by `data-key`, the new node inherits the one its predecessor had, and a
   burst of streamed text is a single continuous glide instead of a series of restarts.

   Finally, the target itself is low-passed. Tokens arrive in bursts, so the tail is a
   staircase, and a spring chasing a staircase accelerates and brakes once per step — fast,
   slow, fast, slow, at the burst rate, which is its own kind of jump. Chasing a smoothed aim
   instead turns that into a ramp: measured over five stream shapes, frame-to-frame speed
   variation drops from ~35% to ~9% and the worst speed change between two frames by roughly
   3x, for about one extra line of lag behind the writing. A deliberate jump skips the low-pass
   and aims straight at its target: there is no staircase to smooth when you asked to be there.

   Anything the user drives — a finger, a wheel, a key — cancels the glide at once. Fighting
   the finger is worse than the snap it replaces. */
const glides = new Map(); // block key -> {el, target, aim, aimTau, vel, omega}
const LIST_KEY = "#list"; // the message list has no block key of its own
let glideFrame = 0;
let glidePrev = 0;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Seconds. FOLLOW_TAU is the position spring (how fast the box closes a gap it is already
 *  chasing); AIM_TAU is the low-pass on the target (how much of the staircase is smoothed
 *  away); MOVE_TAU covers a gap big enough that it is an arrival rather than a correction —
 *  softer, and capped so switching sessions is a glide rather than a slow crawl. */
const FOLLOW_TAU = 0.055;
const AIM_TAU = 0.05;
const MOVE_TAU = 0.13;

/** Deferral, for the streaming follow only (a deliberate jump still goes straight there).
 *  A box will not chase faster than CHASE_SCREENS screens a second, so text arriving quicker
 *  than that piles up below the fold and is then scrolled through at an even rate instead of
 *  the view lurching along with every burst. DEFER_GAIN is how much extra chase each pixel of
 *  backlog buys: the allowance grows with the backlog rather than being dropped at a limit,
 *  so the speed stays continuous however fast the stream runs. A hard bound — cap until the
 *  backlog is N pixels, then let go — measured much worse: the view lurched the moment it hit
 *  the bound (speed variation 202%), because dropping a cap is a step change in velocity.
 *  Set CHASE_SCREENS to 0 to turn deferral off and go back to tracking the tail outright. */
const CHASE_SCREENS = 3;
const DEFER_GAIN = 2.5;

/** Close enough to stop. Below a pixel is invisible, and on a fractional-DPR screen (2.7 here)
 *  scrollTop snaps to device pixels, so it can sit 0.85px short of the target for good: a tighter
 *  threshold left the glide running a frame loop, with a forced layout per frame, indefinitely. */
const ARRIVED_PX = 1;

const clampScroll = (el, v) => Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));

function glideKey(el) {
  return el === messagesEl ? LIST_KEY : bodyKey(el) || el;
}

function glideStep(now) {
  glideFrame = 0;
  // A backgrounded tab hands back one enormous dt on return; clamping keeps a single frame
  // from teleporting the list.
  const dt = Math.min(0.064, (now - glidePrev) / 1000 || 0.016);
  glidePrev = now;
  for (const [key, g] of glides) {
    const el = g.el;
    if (!el.isConnected) { glides.delete(key); continue; } // the block itself is gone
    const target = clampScroll(el, g.target);
    if (g.aimTau) g.aim += (target - g.aim) * (1 - Math.exp(-dt / g.aimTau));
    else g.aim = target;
    const aim = clampScroll(el, g.aim);
    // SmoothDamp: critically damped, so the closed form below never overshoots on its own.
    // The rational approximation of the exponential is what keeps it stable at any dt.
    const omega = g.omega;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = el.scrollTop - aim;
    const temp = (g.vel + omega * change) * dt;
    g.vel = (g.vel - omega * temp) * decay;
    let next = aim + (change + temp) * decay;
    // The tail grew again while we were catching up, and the filter can carry past the new
    // aim. Land on it and drop the velocity rather than swing back. (Crossing *to* the far
    // side is the overshoot; not reaching it yet is the normal case.)
    if (aim > el.scrollTop ? next > aim : next < aim) { next = aim; g.vel = 0; }
    let step = next - el.scrollTop;
    // The follow rate limit: see CHASE_SCREENS. A big gap buys more speed, which is what stops
    // the backlog growing without bound while still never letting go of the tail entirely.
    if (g.aimTau && CHASE_SCREENS > 0) {
      const allowed = (CHASE_SCREENS * el.clientHeight + DEFER_GAIN * Math.abs(target - el.scrollTop)) * dt;
      if (Math.abs(step) > allowed) step = Math.sign(step) * allowed;
    }
    el.scrollTop += step;
    // Arrived: snap the sub-pixel remainder and stop, rather than letting the damped tail
    // keep a rAF alive for a third of a second to close a gap nobody can see.
    if (Math.abs(target - el.scrollTop) < ARRIVED_PX) { el.scrollTop = target; glides.delete(key); }
  }
  if (glides.size) glideFrame = requestAnimationFrame(glideStep);
}

function stopGlide(el) {
  const key = glideKey(el);
  if (glides.delete(key) && !glides.size && glideFrame) {
    cancelAnimationFrame(glideFrame);
    glideFrame = 0;
  }
}

/** Aim `el` at `target`, keeping any velocity already in flight toward it.
 *
 *  The spring constant is chosen once, when the glide starts, and then held: recomputing it
 *  from the remaining distance every pass would let a lagging view pick a softer spring the
 *  more it lagged, and lag into a standstill. A pass that lands mid-glide simply re-aims, and
 *  an explicit tau (a deliberate jump) overrides whatever was in flight. */
function glideTo(el, target, tau) {
  target = clampScroll(el, target);
  const key = glideKey(el);
  const g = glides.get(key);
  if (reduceMotion.matches) {
    stopGlide(el);
    el.scrollTop = target;
    return;
  }
  const distance = Math.abs(target - el.scrollTop);
  if (distance < ARRIVED_PX && !g) return; // already there, and nothing in flight
  // The spring constant is picked once, when the glide starts, and then held: recomputing it
  // from the remaining distance on every pass would let a lagging view choose a softer spring
  // the more it lagged, and lag itself into a standstill. A pass that lands mid-glide simply
  // re-aims, and an explicit tau (a deliberate jump) overrides whatever was in flight.
  const omega = tau ? 2 / tau : g ? g.omega : 2 / Math.min(MOVE_TAU, Math.max(FOLLOW_TAU, distance / 4000));
  // A new glide starts aimed at its target, so opening a box that is already full length is a
  // glide rather than a ramp up to one.
  glides.set(key, { el, target, aim: g?.aim ?? target, aimTau: tau ? 0 : AIM_TAU, vel: g?.vel || 0, omega });
  if (!glideFrame) {
    glidePrev = performance.now();
    glideFrame = requestAnimationFrame(glideStep);
  }
}

/* The finger wins, always. pointerdown covers touch on every engine that ships pointer
   events; wheel is the mouse equivalent. Keys only count when they are scroll keys — typing a
   follow-up must not be read as the reader leaving. */
function cancelGlides(e) {
  const inner = e.target?.closest?.(".think-body, .tool-out");
  if (inner) stopGlide(inner);
  stopGlide(messagesEl);
}
for (const ev of ["pointerdown", "wheel", "touchstart"]) {
  messagesEl.addEventListener(ev, cancelGlides, { passive: true, capture: true });
}
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
window.addEventListener("keydown", (e) => {
  if (SCROLL_KEYS.has(e.key)) stopGlide(messagesEl);
}, { passive: true });

/* ---------- sticky inner scroll ----------
   Thinking bodies and tool outputs scroll on their own. Re-rendering resets scrollTop to
   0, which left a streaming block frozen at its first line, so open bodies are pushed
   back to the bottom — unless the user scrolled up inside one, in which case that
   position is remembered and restored instead (otherwise reading back is impossible while
   the agent keeps writing). The offset survives the node: the body is rebuilt every render,
   so its position is read off the outgoing one first (see harvestBodyScroll), which is also
   what turns the follow into a glide rather than a fresh jump from the top. */
const unpinnedBodies = new Set();
const bodyScrollTop = new Map();

function updateJumpBottom() {
  jumpBottomBtn.hidden = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 120;
}

messagesEl.addEventListener("scroll", updateJumpBottom, { passive: true });
jumpBottomBtn.addEventListener("click", () => {
  stopGlide(messagesEl);
  glideTo(messagesEl, messagesEl.scrollHeight, MOVE_TAU);
});

function bodyKey(el) {
  return el.closest("details[data-key]")?.dataset.key;
}

messagesEl.addEventListener("scroll", (e) => {
  const body = e.target?.closest?.(".think-body, .tool-out");
  const key = body && bodyKey(body);
  if (!key) return;
  if (glides.has(glideKey(body))) return; // our own writes, not the user leaving
  bodyScrollTop.set(key, body.scrollTop);
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 24) unpinnedBodies.delete(key);
  else unpinnedBodies.add(key);
}, true); // scroll does not bubble; capture catches it from the bodies

/* ---------- helpers ---------- */

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

/* ---------- durations ----------
   How long a thought, a tool call or a whole message took. The server stamps each block when it
   first sees it (see timings.ts) and sends either a finished `ms` or the `at` it started at; a
   block that is still running ticks locally from `at`, so a slow tool counts up even while the
   agent is quiet. Nothing here waits on the server clock: the server is this same process. */

function fmtDur(ms) {
  ms = Math.max(0, ms | 0);
  if (ms < 950) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** A finished duration, or a live one that ticks itself via tickDurations(). */
function durHtml(ms, at) {
  if (ms !== undefined && ms !== null) return `<span class="dur">${fmtDur(ms)}</span>`;
  if (at) return `<span class="dur dur-live" data-since="${at}">${fmtDur(Date.now() - at)}</span>`;
  return "";
}

/** Only the running spans are touched, and only while something is running. During a stream
 *  inspect the changed tail; the one-second timer may scan the whole history when needed. */
function tickDurations(root = messagesEl) {
  const now = Date.now();
  let live = false;
  root.querySelectorAll(".dur-live[data-since]").forEach((el) => {
    el.textContent = fmtDur(now - Number(el.dataset.since));
    live = true;
  });
  if (root === messagesEl) {
    if (live !== ticking) {
      ticking = live;
      clearInterval(durTimer);
      if (live) durTimer = setInterval(tickDurations, 1000);
    }
  } else if (live && !ticking) {
    ticking = true;
    durTimer = setInterval(tickDurations, 1000);
  }
}
let ticking = false;
let durTimer = 0;

/** Minimal markdown: fenced code, inline code, bold. Everything else stays plain text. */
function md(text) {
  const parts = String(text).split(/```/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre class="code">${escapeHtml(part.replace(/^[^\n]*\n/, ""))}</pre>`;
    return escapeHtml(part)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }).join("");
}

/** The same output as md(), as pieces that can be patched independently: a fenced block, or a
 *  paragraph of plain text (cut after each blank line). Inline code and bold never span a newline,
 *  so cutting there cannot change how either renders. While a reply streams, only its last piece
 *  differs from one update to the next, so only that piece is re-parsed. */
function mdChunks(text) {
  const out = [];
  String(text).split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre class="code">${escapeHtml(part.replace(/^[^\n]*\n/, ""))}</pre>`);
      return;
    }
    for (const chunk of part.match(/[\s\S]*?(?:\n\n+|$)/g) || []) {
      if (chunk) out.push(`<span>${md(chunk)}</span>`);
    }
  });
  return out;
}

/* ---------- tool views ----------
   An extension can say how its own tool should read: an icon, which argument to put on the
   collapsed row, what the expanded body shows (see extensions.ts). The specs ride along with the
   chat view, keyed by tool name, and are consulted before the name-based guesses below. A tool
   with no spec -- or a spec this page does not know -- renders exactly as it always did. */

let toolViews = {};

function toolView(name) {
  return toolViews[name] || null;
}

/** The body a tool gets when nothing declared one: the previews that exist, keyed by tool name. */
function defaultBody(name) {
  if (name === "web_search") return "cards";
  if (name === "edit") return "diff";
  if (name === "write") return "file";
  if (name === "bash") return "command";
  return "json";
}

function toolSummary(name, args) {
  if (args && typeof args === "object") {
    const guess = args.command ?? args.path ?? args.file_path ?? Object.values(args)[0];
    // A view may name the argument to show; if it names one the call does not have, the guess stands.
    const first = toolView(name)?.summaryArg ? args[toolView(name).summaryArg] ?? guess : guess;
    if (first !== undefined) {
      const summary = String(typeof first === "string" ? first : JSON.stringify(first)).replace(/\s+/g, " ");
      return name === "edit" ? summary : summary.slice(0, 90);
    }
  }
  return "";
}

/* ---------- tool previews ----------
   The expanded body of a tool call used to be a JSON dump of the arguments, which is
   unreadable for the two tools that actually change something: `edit` showed
   {"path":"...","edits":[{"oldText":"...","newText":"..."}]} and `write` showed the entire
   file as escaped JSON. Both now render what the call did -- a unified diff for `edit`, the
   new content for `write` -- using the same colours as the Changes tab. */

/** Lines of unchanged context kept around each change, like a unified diff. */
const DIFF_CONTEXT = 3;
/** Above this many cells the LCS table is skipped rather than locking up the UI thread. */
const DIFF_CELL_LIMIT = 250_000;
/** A `write` preview longer than this is clipped: the arguments are already on the wire, so
 *  building a 10k-line HTML string on every streaming push would be the expensive part. */
const WRITE_PREVIEW_LINES = 400;

/**
 * Longest common subsequence over lines, as typed rows (1 = same, 0 = removed, 2 = added).
 * Common prefix/suffix lines are trimmed first, which is what makes a small edit inside a big
 * block cheap: only the differing middle goes through the table. Returns null if the middle is
 * too large to diff, and the caller falls back to a count-only summary.
 */
function diffRows(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }

  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  const width = midB.length + 1;
  if (midA.length * midB.length > DIFF_CELL_LIMIT) return null;

  const dp = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      dp[i * width + j] = midA[i] === midB[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const rows = [];
  for (let i = 0; i < head; i++) rows.push({ t: 1, s: a[i] });
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) { rows.push({ t: 1, s: midA[i] }); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { rows.push({ t: 0, s: midA[i] }); i++; }
    else { rows.push({ t: 2, s: midB[j] }); j++; }
  }
  while (i < midA.length) rows.push({ t: 0, s: midA[i++] });
  while (j < midB.length) rows.push({ t: 2, s: midB[j++] });
  for (let k = tailA; k < a.length; k++) rows.push({ t: 1, s: a[k] });
  return rows;
}

/** Collapse a row list to hunks, so unchanged stretches don't push the change off screen. */
function toHunks(rows, context = DIFF_CONTEXT) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((row, idx) => {
    if (row.t === 1) return;
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep[k] = 1;
  });
  const out = [];
  let skipped = 0;
  rows.forEach((row, idx) => {
    if (keep[idx]) {
      if (skipped) { out.push({ hunk: true, s: skipped }); skipped = 0; }
      out.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ hunk: true, s: skipped });
  return out;
}

const DIFF_CLASS = { 0: "del", 1: "", 2: "add" };
const DIFF_MARK = { 0: "-", 1: " ", 2: "+" };

function rowsHtml(rows) {
  return rows.map(row =>
    row.hunk
      ? `<span class="hunk">… ${row.s} unchanged line${row.s === 1 ? "" : "s"}</span>`
      : `<span class="${DIFF_CLASS[row.t]}">${DIFF_MARK[row.t]}${escapeHtml(row.s)}</span>`,
  ).join("\n");
}

/** A unified diff of before -> after, with "+n −m" in the label. Falls back to a count-only
 *  note when the two sides are too big to diff, rather than hanging or dumping raw text. */
function diffPreview(before, after) {
  const rows = diffRows(before, after);
  const added = rows ? rows.filter(r => r.t === 2).length : after.split("\n").length;
  const removed = rows ? rows.filter(r => r.t === 0).length : before.split("\n").length;
  const stats = `<span class="diff-stat"><span class="add">+${added}</span> <span class="del">−${removed}</span></span>`;
  if (!rows) return { stats, html: `<p class="tool-note">Too large to diff here (${removed} lines out, ${added} in).</p>` };
  const hunks = toHunks(rows);
  return { stats, html: `<pre class="diff tool-diff">${rowsHtml(hunks)}</pre>` };
}

function toolLabel(text, extra = "") {
  return `<div class="tool-label">${text}${extra}</div>`;
}

/** `edit`: one labelled diff per replacement, so a multi-edit call stays readable. */
function editPreview(args) {
  // The tool takes {path, edits:[{oldText,newText}]}; older transcripts carry the flat
  // {oldText,newText} form, which is still worth rendering properly.
  const edits = Array.isArray(args.edits) && args.edits.length
    ? args.edits
    : args.oldText !== undefined
      ? [{ oldText: args.oldText, newText: args.newText }]
      : [];
  if (!edits.length) return "";
  const body = edits.map((edit, idx) => {
    const { stats, html } = diffPreview(String(edit.oldText ?? ""), String(edit.newText ?? ""));
    const head = edits.length > 1 ? ` ${idx + 1}/${edits.length}` : "";
    return toolLabel(`diff${head}`, ` ${stats}`) + html;
  }).join("");
  return body;
}

/** `write`: the content being written, clipped, with its size in the label. */
function writePreview(args) {
  const content = String(args.content ?? "");
  const lines = content.split("\n");
  const shown = lines.slice(0, WRITE_PREVIEW_LINES);
  const clipped = lines.length > WRITE_PREVIEW_LINES;
  const size = content.length < 1024 ? `${content.length} B` : `${(content.length / 1024).toFixed(1)} KB`;
  return (
    toolLabel("content", ` ${lines.length} line${lines.length === 1 ? "" : "s"}, ${size}`) +
    `<pre class="code tool-out">${escapeHtml(shown.join("\n"))}${clipped ? `\n… ${lines.length - WRITE_PREVIEW_LINES} more lines` : ""}</pre>`
  );
}

/**
 * `web_search`: the results as cards, not as the numbered text dump the model reads.
 *
 * Parsed back out of the tool's own output rather than shipped alongside it. The UI only ever gets
 * the text (that is what the tool returns), and the text is also the model's copy, so a second
 * machine-readable payload would be a second format to keep in step with the first. The shape is
 * fixed by extensions/web-search.ts: a `Results for "<query>" (via <provider>):` header, then per
 * result a `N. Title (date)` line and two indented lines, url then excerpt. Anything that does not
 * match -- a provider error, or output from an older version -- returns "" and falls through to the
 * plain rendering, so this can never swallow a message it does not understand.
 */
function webSearchPreview(output) {
  const lines = String(output).split("\n");
  const header = lines[0]?.match(/^Results for "(.+)" \(via ([\w-]+)\):$/);
  if (!header) return "";
  const [, query, provider] = header;

  const results = [];
  let note = "";
  for (const line of lines.slice(1)) {
    const head = line.match(/^(\d+)\.\s+(.+)$/);
    if (head) {
      // The title line carries the publication date in trailing parens, but only when there is
      // one: a title that ends in its own parentheses must not lose them to this.
      const dated = head[2].match(/^(.*?)\s+\((\d{4}-\d{2}-\d{2}[^)]*)\)$/);
      results.push({ rank: head[1], title: dated ? dated[1] : head[2], date: dated ? dated[2] : "", url: "", snippet: "" });
      continue;
    }
    if (!results.length) continue;
    if (line.startsWith("(")) {
      note = line.replace(/^\(|\)$/g, "");
      continue;
    }
    const body = line.trim();
    if (!body) continue;
    const current = results[results.length - 1];
    if (!current.url && /^https?:\/\//i.test(body)) current.url = body;
    else current.snippet = body;
  }
  if (!results.length) return "";

  const items = results.map((r) => {
    const meta = [hostOf(r.url), r.date].filter(Boolean).join("  ·  ");
    const body =
      `<span class="ws-rank">${escapeHtml(r.rank)}</span>` +
      `<span class="ws-main">` +
      `<span class="ws-title">${escapeHtml(r.title)}</span>` +
      (meta ? `<span class="ws-meta">${escapeHtml(meta)}</span>` : "") +
      (r.snippet ? `<span class="ws-snip">${escapeHtml(r.snippet)}</span>` : "") +
      `</span>`;
    // The result URL decides its own fate: only http(s) becomes a link, anything else stays plain
    // text rather than becoming an href the user could tap.
    return /^https?:\/\//i.test(r.url)
      ? `<a class="ws-item" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${body}</a>`
      : `<div class="ws-item">${body}</div>`;
  }).join("");

  return (
    `<div class="ws">` +
    `<div class="ws-head"><span class="ws-q">${escapeHtml(query)}</span><span class="ws-prov">${escapeHtml(provider)}</span></div>` +
    items +
    (note ? `<div class="ws-note">${escapeHtml(note)}</div>` : "") +
    `</div>`
  );
}

/** Host of a URL for display, or "" when there is not one. Never throws on a bad URL. */
function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ---------- plots ----------
   A curve, drawn from a {"plot":...} payload that the tool left as the last line of its own
   output (extensions/plot.ts), the same way web_search leaves text its cards are parsed back out
   of. Nothing here evaluates the expression: the extension sampled the curve server-side and only
   numbers crossed the wire, so this is a mapping from samples to pixels and nothing more. The
   x values are not even sent -- xStep and xMin rebuild them -- which halves the payload and makes
   it impossible for the two to disagree.

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

function plotPreview(output, live = false) {
  const lines = String(output).split("\n");
  let line = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{"plot":')) { line = lines[i]; break; }
  }
  if (!line) return "";

  let p;
  try { p = JSON.parse(line).plot; } catch { return ""; }
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
    grid.push(`<text class="plot-tick" x="${x}" y="${top + height + 14}" text-anchor="middle">${escapeHtml(fmtTick(t))}</text>`);
  }
  for (const t of plotTicks(p.yMin, p.yMax, 4)) {
    const y = r1(py(t));
    grid.push(`<line class="plot-grid" x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" />`);
    grid.push(`<text class="plot-tick" x="${left - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(fmtTick(t))}</text>`);
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

  /* ---------- animation ----------
     p.animate runs a single dot along the curve, from the left of the window to the right.

     SMIL rather than CSS, deliberately. The dot has to follow the curve in the SVG's own user
     units, so it stays glued to the line whatever width the graph is drawn at; CSS offset-path
     would be working in CSS pixels on an SVG element, which is unevenly supported and drifts off
     the curve as the graph scales. SMIL moves along a path in user units natively.

     One dot per stroke, each offset to start at its share of the arc length, so the dot keeps one
     steady speed across strokes instead of racing through a short branch and crawling along a long
     one. Each repeats, so it loops for as long as the row is open. Where the curve leaves the
     window the dot jumps to the next stroke -- the same jump the curve makes, rather than one
     smoothed over a gap the graph is trying to show.

     Nothing animates while the call is still running (live): the list is rebuilt on every push of
     a streaming run, and SMIL starts over each time, which would look frozen rather than animated.
     It begins once the result is committed and the view settles. */
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

  const caption = expr ? `y = ${escapeHtml(expr)}` : "graph";
  const alt = `${caption}, x from ${fmtTick(p.xMin)} to ${fmtTick(xOf(last))}, y from ${fmtTick(p.yMin)} to ${fmtTick(p.yMax)}`;
  return (
    `<div class="plot">` +
    `<svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" role="img" aria-label="${escapeHtml(alt)}" preserveAspectRatio="xMidYMid meet">` +
    grid.join("") + axes.join("") + paths.join("") + motion +
    `</svg>` +
    `<div class="plot-cap">${caption}<span class="plot-range">${escapeHtml(fmtTick(p.xMin))} … ${escapeHtml(fmtTick(xOf(last)))}</span></div>` +
    `</div>`
  );
}

/** The expanded body of a tool call: a real preview where there is one, JSON otherwise.
 *  `live` is true while the call is still running, which is what stops a plot from animating. */
function toolBodyHtml(call, args, output, live = false) {
  const view = toolView(call.name);
  const body = view?.body ?? defaultBody(call.name);
  // The result text is the tool's own account of what happened, so it rides along unless the view
  // drops it -- or unless the body is made of it, which would show it twice.
  const outputHtml = output && !view?.hideOutput && body !== "output" && body !== "diff"
    ? toolLabel("output") + `<pre class="code tool-out">${escapeHtml(output)}</pre>`
    : "";

  if (body === "cards" && typeof output === "string") {
    // The cards carry everything the raw text did -- title, host, date, excerpt -- so keeping the
    // dump underneath would just be the same results twice. Only when the cards cannot be built (a
    // provider error, or output from before this renderer existed) does the text stay, because then
    // it is the only copy of what happened.
    const results = webSearchPreview(output);
    if (results) return results;
  }

  if (body === "plot") {
    // The curve is the whole point of the call, so it replaces the text; a payload that will not
    // parse leaves the text below, which is then the only copy of what was plotted.
    const plot = plotPreview(output, live);
    if (plot) return plot;
  }

  // Nothing to show for the result yet (a call still streaming): fall through to the arguments, so
  // the body is not blank while it runs.
  if (body === "output" && output) {
    return toolLabel("output") + `<pre class="code tool-out">${escapeHtml(output)}</pre>`;
  }

  if (body === "command" && typeof args.command === "string") {
    return toolLabel(view?.label ?? "command") + `<pre class="code">${escapeHtml(args.command)}</pre>` + outputHtml;
  }

  let preview = "";
  if (body === "diff") preview = editPreview(args);
  else if (body === "file" && typeof args.content === "string") preview = writePreview(args);
  if (preview) return preview + outputHtml;

  const argsText = JSON.stringify(args, null, 2);
  return toolLabel(view?.label ?? "arguments") + `<pre class="code">${escapeHtml(argsText)}</pre>` + outputHtml;
}

function isOpen(key, byDefault) {
  if (userOpen.has(key)) return true;
  if (userClosed.has(key)) return false;
  return byDefault;
}

/* ---------- rendering ---------- */

function thinkingBlock(key, block, streaming) {
  const open = isOpen(key, streaming);
  const body = escapeHtml(block.text) || "…";
  const label = streaming ? '<span class="shimmer">Thinking…</span>' : `${icon("brain", 13, "ico-inline")} Thought`;
  return `
    <details class="think" data-key="${key}" ${open ? "open" : ""}>
      <summary>${label}${durHtml(block.ms, streaming ? block.at : undefined)}</summary>
      <div class="think-body">${body}</div>
    </details>`;
}

function toolBlock(key, call, state, result) {
  const running = state && state.status !== "done" && !result;
  const failed = result?.isError;
  // No done/pending badge: a finished call is indistinguishable from the others. Only the
  // spinner while it runs and a red row when it fails carry state.
  const status = running ? `<span class="tool-status">${icon("loader-circle", 12, "spin")}</span>` : "";
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const output = result ? result.text : state?.output;
  const view = toolView(call.name);
  // web_search and edit are open by default because their body is the point of the call; anything
  // else stays closed until asked. A view can decide for its own tool either way.
  const openByDefault = view?.open ?? (call.name === "web_search" || call.name === "edit");
  return `
    <details class="tool${failed ? " failed" : ""}${call.name === "edit" ? " edit-tool" : ""}" data-key="${key}" ${isOpen(key, openByDefault) ? "open" : ""}>
      <summary>
        <span class="tool-ico">${icon(view?.icon ?? toolIcon(call.name), 14)}</span>
        <span class="tool-name">${escapeHtml(call.name)}</span>
        <span class="tool-sum">${escapeHtml(toolSummary(call.name, args))}</span>
        ${running ? durHtml(undefined, call.at) : durHtml(call.ms, undefined)}
        ${status}
      </summary>
      <div class="tool-body">${toolBodyHtml(call, args, output, running)}</div>
    </details>`;
}

function assistantParts(idKey, blocks, live, results, tools, error, ms, branchAfter, messageId) {
  const parts = blocks.map((b, i) => {
    const key = `${idKey}-${i}`;
    if (b.type === "thinking") {
      // Streaming thinking stays open only while it is the block being written.
      return thinkingBlock(key, b, live && i === blocks.length - 1);
    }
    if (b.type === "toolCall") return toolBlock(`t-${b.id}`, b, tools.get(b.id), results.get(b.id));
    // Committed text arrives pre-rendered from the server (chatview.ts); the streaming
    // partial has no html yet, so it is rendered here.
    if (!b.text.trim()) return "";
    const open = '<div class="message assistant"><div class="message-content">';
    if (b.html !== undefined) return `${open}${b.html}</div></div>`;
    return { open, into: ".message-content", close: "</div></div>", parts: mdChunks(b.text) };
  });
  if (error) parts.push(`<div class="message assistant error"><div class="message-content">${escapeHtml(error)}</div></div>`);
  // One dim line per assistant message: how long the model took to think it through and write
  // it. Tool calls carry their own durations on their rows.
  if (!live && ms !== undefined) parts.push(`<div class="message-meta">${iconTag("clock", 12, "dim")} Worked ${fmtDur(ms)}</div>`);
  // data-branch-after is the entry to branch at for a session starting just after this answer. It is
  // only set when the server marked the message as a valid branch point (no unanswered tool calls).
  const fork = branchAfter === undefined ? "" : ` data-branch-after="${branchAfter}"`;
  const identity = messageId === undefined ? "" : ` data-message-id="${messageId}"`;
  return { key: idKey, open: `<div class="turn"${fork}${identity}>`, parts: parts.filter((p) => p), close: "</div>" };
}

function assistantHtml(...args) {
  const t = assistantParts(...args);
  return t.open + t.parts.join("") + t.close;
}

/* ---------- live tail patching ----------
   The tail (the pending tool message, the streaming partial, the queue) used to be thrown away
   and re-parsed from innerHTML on every update, several times a second, even though only the
   last block of it had changed. It is now a list of slots, each remembering the html it last
   produced for every block; a block whose html is unchanged keeps its node (and with it its
   scroll offset, selection, open state and running animation), and only the blocks that differ
   are re-parsed. A slot is a turn (wrapper + blocks) or a single loose element (no wrapper). */
const tailState = { slots: [] };
const historyState = { slots: [] };
const parseTpl = document.createElement("template");

function parseEl(html) {
  parseTpl.innerHTML = html;
  return parseTpl.content.firstElementChild;
}

/** Brings the children of `container` in line with `want`, keeping every node whose html is
 *  unchanged. A wanted part is html, or {open, into, close, parts} for a wrapper whose own
 *  children are synced the same way. New or replaced top-level nodes go into `created`. */
function syncParts(container, have, want, created) {
  for (let j = 0; j < want.length; j++) {
    const w = want[j];
    const leaf = typeof w === "string";
    const sig = leaf ? w : w.open;
    const h = have[j];
    if (h && h.sig === sig) {
      if (!leaf) syncParts(h.target, h.kids, w.parts, created);
      continue;
    }
    const el = parseEl(leaf ? w : w.open + w.close);
    const entry = { sig, el };
    if (!leaf) {
      entry.target = w.into ? el.querySelector(w.into) : el;
      entry.kids = [];
      syncParts(entry.target, entry.kids, w.parts, []);
    }
    created.push(el);
    if (h) h.el.replaceWith(el);
    else container.append(el);
    have[j] = entry;
  }
  for (const gone of have.splice(want.length)) gone.el.remove();
}

/** Items are {key, open, parts, close} turns or {key, parts:[html]} loose elements. Returns the
 *  nodes that were (re)created, so the caller only restores state on those. */
function patchList(root, items, state) {
  const slots = state.slots;
  const created = [];
  let i = 0;
  for (; i < items.length && i < slots.length; i++) {
    const item = items[i], slot = slots[i];
    if (slot.key !== item.key || slot.open !== item.open) break;
    if (slot.wrapper) {
      syncParts(slot.wrapper, slot.parts, item.parts, created);
    } else if (slot.parts[0].sig !== item.parts[0]) {
      const el = parseEl(item.parts[0]);
      slot.parts[0].el.replaceWith(el);
      slot.parts[0] = { sig: item.parts[0], el };
      created.push(el);
    }
  }
  // From the first mismatch on, rebuild: a changed key means a different message anyway.
  for (let k = i; k < slots.length; k++) (slots[k].wrapper || slots[k].parts[0].el).remove();
  slots.length = i;
  for (; i < items.length; i++) {
    const item = items[i];
    if (item.open === undefined) {
      const el = parseEl(item.parts[0]);
      root.append(el);
      created.push(el);
      slots.push({ key: item.key, wrapper: null, parts: [{ sig: item.parts[0], el }] });
      continue;
    }
    const wrapper = parseEl(item.open + item.close);
    const parts = [];
    syncParts(wrapper, parts, item.parts, []);
    root.append(wrapper);
    created.push(wrapper);
    slots.push({ key: item.key, open: item.open, wrapper, parts });
  }
  return created;
}

function stampAnimPhase() {
  const phase = (Math.round(performance.now() / 1000 / ANIM_PHASE_STEP) * ANIM_PHASE_STEP).toFixed(2);
  if (phase === lastPhase) return;
  lastPhase = phase;
  messagesEl.style.setProperty("--anim-phase", `${phase}s`);
}

/** The bodies about to be replaced hold the only live copy of their offsets — including a
 *  glide caught mid-flight — so read them before touching that region. */
function harvestBodyScroll(root = messagesEl) {
  root.querySelectorAll("details[data-key] .think-body, details[data-key] .tool-out").forEach((el) => {
    const key = bodyKey(el);
    if (key) bodyScrollTop.set(key, el.scrollTop);
  });
}

/** `animate` is for the streaming tail. A body in committed history has nothing arriving, so it
 *  is placed at its position outright: gliding every one of them on a page or session load kept
 *  dozens of springs (and a forced layout per spring per frame) running for seconds. */
function restoreBodyScroll(root, animate = true) {
  root.querySelectorAll("details[data-key] .think-body, details[data-key] .tool-out").forEach((el) => {
    const key = bodyKey(el);
    // Start where this body was: the outgoing node's offset is what makes the glide a continuation.
    el.scrollTop = (key && bodyScrollTop.get(key)) || 0;
    if (!key || !unpinnedBodies.has(key)) {
      if (animate) glideTo(el, el.scrollHeight);
      else el.scrollTop = el.scrollHeight;
    }
    if (el.classList.contains("think-body")) el.classList.toggle("overflowing", el.scrollHeight - el.clientHeight > 2);
  });
}

/* ---------- block entrance ----------
   A tool row or a thought that arrives while the list is already settled would otherwise pop
   in between two static blocks. One short fade-and-rise marks it as new without moving
   anything the eye is reading. These nodes are rebuilt on every render, so — like the shimmer
   — the animation is stamped from when the key was first seen: the fresh copy resumes where
   its predecessor was instead of restarting, and streaming never stalls it. */
const BLOCK_IN_MS = 260;
const firstSeen = new Map();

/** `m12-0` -> `live-0`: the same block before and after a run is committed. */
const liveAlias = (key) => key.replace(/^m\d+-/, "live-");

/** Blocks still inside their entrance animation, so a streaming render revisits only those and
 *  the nodes it just created instead of every keyed block in the tail. */
const freshEls = new Set();

/** `created` is what a patch just (re)built; kept nodes are untouched, so they need no visit. */
function markFreshIn(created) {
  const els = new Set(freshEls);
  for (const root of created) {
    if (root.dataset?.key) els.add(root);
    root.querySelectorAll?.("[data-key]").forEach((el) => els.add(el));
  }
  markFreshBlocks(messagesEl, [...els].filter((el) => el.isConnected));
}

function markFreshBlocks(root = messagesEl, only) {
  const now = performance.now();
  const rows = [];
  (only || root.querySelectorAll("[data-key]")).forEach((el) => {
    const key = el.dataset.key;
    let t = firstSeen.get(key);
    if (t === undefined) t = firstSeen.get(liveAlias(key));
    if (t === undefined) { t = now; firstSeen.set(key, t); }
    rows.push({ el, age: now - t });
  });

  // A whole history showing up at once (session switch, reload) is not an arrival, and fading
  // every row in together would only flash the screen. A couple of new rows between settled
  // ones is what actually turns up mid-read, and that is what gets the animation.
  const arriving = rows.filter((r) => r.age < BLOCK_IN_MS);
  const animate = arriving.length <= 3;
  for (const { el, age } of rows) {
    const live = animate && age < BLOCK_IN_MS;
    if (live) freshEls.add(el);
    else freshEls.delete(el);
    if (live) {
      el.classList.add("fresh");
      el.style.animationDelay = `${-(age / 1000).toFixed(3)}s`;
    } else if (el.classList.contains("fresh")) {
      el.classList.remove("fresh");
      el.style.animationDelay = "";
    }
    // A bulk load must not still look brand new on the next render, or the first real
    // arrival after it would be counted as part of the crowd and skipped too.
    if (!live && age < BLOCK_IN_MS) firstSeen.set(el.dataset.key, now - BLOCK_IN_MS);
  }
}

function pruneFreshBlocks() {
  const visible = new Set();
  for (const root of [historyEl, dynamicEl]) {
    root.querySelectorAll("[data-key]").forEach((el) => visible.add(el.dataset.key));
  }
  // Keys for blocks that are gone (a branch switch, another session) would otherwise keep
  // their offsets and first-seen times for the life of the page.
  for (const key of firstSeen.keys()) {
    if (visible.has(key)) continue;
    firstSeen.delete(key);
    bodyScrollTop.delete(key);
    unpinnedBodies.delete(key);
  }
}

function lastPendingToolMessage(messages, results, busy) {
  if (!busy) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "tool" || message.role === "event") continue;
    if (message.role !== "assistant") return null;
    return (message.blocks || []).some((block) => block.type === "toolCall" && !results.has(block.id))
      ? message
      : null;
  }
  return null;
}

let signedViews = null;
let viewsSignature = "";
function toolViewSignature(views) {
  // The server keeps the same specs until an extension changes, so serialize only when they do.
  if (views === signedViews) return viewsSignature;
  signedViews = views;
  viewsSignature = Object.keys(views).sort().map((name) => `${name}:${JSON.stringify(views[name])}`).join("|");
  return viewsSignature;
}

function renderMessages(view, sessionId) {
  const messages = Array.isArray(view.messages) ? view.messages : [];
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.callId, m]));
  const tools = new Map((view.tools || []).map((t) => [t.callId, t]));
  const active = lastPendingToolMessage(messages, results, view.busy);
  toolViews = view.toolViews || {};

  // The transcript is append-only. Its small id signature detects new commits / trims without
  // serializing the entire payload; the stream-only WebSocket patch leaves history untouched.
  const first = messages[0]?.id ?? "";
  const last = messages[messages.length - 1]?.id ?? "";
  const signature = `${sessionId ?? ""}|${messages.length}|${first}|${last}|${active?.id ?? ""}|${toolViewSignature(toolViews)}`;
  const historyChanged = signature !== lastHistoryKey;

  stampAnimPhase();
  // Following the tail: near enough to the bottom that streaming should keep pushing. A glide
  // already heading for the bottom counts too — a long arrival settles over a moment, and a
  // render landing in the middle of it must not read that as the user having walked away.
  const bottom = clampScroll(messagesEl, Infinity);
  const glide = glides.get(LIST_KEY);
  const following = bottom - messagesEl.scrollTop < 120 || (!!glide && glide.target >= bottom - 1);
  if (historyChanged) harvestBodyScroll(messagesEl);
  else harvestBodyScroll(dynamicEl);

  let historyCreated = [];
  if (historyChanged) {
    const historyItems = [];
    historyHasContent = false;
    const loose = (key, html) => historyItems.push({ key, parts: [html] });
    for (const m of messages) {
      if (m.role === "event" && (m.modelChange || m.thinkingChange)) {
        const change = m.modelChange || m.thinkingChange;
        const isModel = !!m.modelChange;
        const label = isModel ? "Model switched" : "Thinking effort changed";
        loose(`mc${m.id}`, `<div class="message model-event" data-key="mc${escapeHtml(m.id)}">${iconTag(isModel ? "cpu" : "brain", 13, "dim")}<span>${label} from <strong>${escapeHtml(change.from)}</strong> to <strong>${escapeHtml(change.to)}</strong></span></div>`);
        historyHasContent = true;
      } else if (m.role === "user") {
        // data-branch-before points at the entry ahead of this prompt, so a new session can start there
        // and replay it. Absent on the first message of a conversation, which has nothing before it.
        const fork = m.branchBefore === undefined ? "" : ` data-branch-before="${m.branchBefore}"`;
        loose(`u${m.id}`, `<div class="message user" data-key="u${m.id}"${fork}><div class="message-content">${escapeHtml(m.text)}</div></div>`);
        historyHasContent = true;
      } else if (m.role === "assistant" && m.id !== active?.id) {
        const error = m.stop === "error" || m.stop === "aborted" ? (m.error || (m.stop === "aborted" ? "Stopped" : "")) : "";
        historyItems.push(assistantParts(`m${m.id}`, m.blocks || [], false, results, tools, error, m.ms, m.branchAfter, m.id));
        historyHasContent = true;
      }
    }
    // A commit appends one message; patching keeps every other node (and its scroll offsets,
    // selection and open state) instead of re-parsing the whole transcript.
    historyCreated = patchList(historyEl, historyItems, historyState);
    enhanceCodeBlocks(historyEl);
    lastHistoryKey = signature;
  }

  // The only committed message whose tool state can still change is the pending tail. Keep it
  // beside the streaming partial so status/output updates do not force a transcript repaint.
  const tailItems = [];
  if (active) {
    const error = active.stop === "error" || active.stop === "aborted" ? (active.error || (active.stop === "aborted" ? "Stopped" : "")) : "";
    tailItems.push(assistantParts(`m${active.id}`, active.blocks || [], false, results, tools, error, active.ms, active.branchAfter, active.id));
  }
  if (view.live?.blocks?.length) tailItems.push(assistantParts("live", view.live.blocks, true, results, tools, ""));
  else if (view.busy) {
    const since = view.runStartedAt ? durHtml(undefined, view.runStartedAt) : "";
    tailItems.push({ key: "working", parts: [`<div class="message assistant thinking"><div class="message-content"><span class="shimmer">Working…</span>${since}</div></div>`] });
  }

  (view.queue || []).forEach((q, n) => {
    tailItems.push({ key: `q${n}`, parts: [`<div class="message user queued"><div class="message-content">${escapeHtml(q.text)}</div><div class="message-meta">${iconTag("clock", 12, "dim")} queued · sends after the current step</div></div>`] });
  });
  if (!historyHasContent && !tailItems.length) {
    tailItems.push({ key: "empty", parts: ['<p class="description empty">Give the agent a task. It can read, write and edit its own UI and files, and run commands.</p>'] });
  }
  const created = patchList(dynamicEl, tailItems, tailState);
  enhanceCodeBlocks(dynamicEl);

  if (following) glideTo(messagesEl, messagesEl.scrollHeight);
  updateJumpBottom();
  for (const el of historyCreated) restoreBodyScroll(el, false);
  for (const el of created) restoreBodyScroll(el);
  if (historyChanged) {
    markFreshBlocks(messagesEl);
    pruneFreshBlocks();
    tickDurations(messagesEl);
  } else {
    markFreshIn(created);
    tickDurations(dynamicEl);
  }
}

function renderStats(view) {
  const s = view.stats;
  if (s.contextWindow > 0) {
    const pct = Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100));
    ctxLabel.textContent = `${fmtTokens(s.contextTokens)}/${fmtTokens(s.contextWindow)}`;
    ctxPct.textContent = `${pct}%`;
    ctxPct.hidden = false;
    ctxPill.title = `Context: ${s.contextTokens.toLocaleString()} of ${s.contextWindow.toLocaleString()} tokens used (${pct}%)`;
    ctxPill.classList.toggle("hot", pct >= 90);
    ctxPill.classList.toggle("warm", pct >= 70 && pct < 90);
    ctxFill.style.width = `${pct}%`;
    ctxFill.className = `meter-fill ${pct >= 90 ? "hot" : pct >= 70 ? "warm" : ""}`;
  } else {
    ctxLabel.textContent = "–";
    ctxPct.hidden = true;
    ctxPill.classList.remove("hot", "warm");
    ctxPill.title = "Context window usage";
    ctxFill.style.width = "0";
    ctxFill.className = "meter-fill";
  }
  cacheLabel.textContent = s.cacheLast === undefined ? "Cache –" : `Cache ${s.cacheLast}%`;
  cacheLabel.title = s.cacheSession === undefined ? "Prompt cache hit rate"
    : `Prompt cache hit rate: ${s.cacheLast}% last request, ${s.cacheSession}% over this conversation`;

  if (typeof s.cost === "number") {
    costLabel.textContent = `$${s.cost > 0 && s.cost < 0.01 ? s.cost.toFixed(4) : s.cost.toFixed(2)}`;
    costLabel.title = `${s.cost.toFixed(4)} spent in this session`;
    costLabel.hidden = false;
  } else {
    costLabel.hidden = true;
  }
}

function renderControls(data) {
  const view = data.view;
  updateComposerAction();
  const queueCount = view.queue.length;
  if (queueCount) {
    queueBar.hidden = false;
    if (queueCount !== lastQueueCount) {
      queueBar.innerHTML = `${iconTag("clock", 13)} ${queueCount} message${queueCount > 1 ? "s" : ""} queued`;
      lastQueueCount = queueCount;
    }
  } else {
    queueBar.hidden = true;
    lastQueueCount = 0;
  }

  const { levels, current } = data.thinking;
  const signature = levels.join(",") + "|" + current;
  if (thinkingSelect.dataset.sig !== signature) {
    thinkingSelect.dataset.sig = signature;
    thinkingSelect.innerHTML = levels.map(l => `<option value="${l}">${l === "off" ? "Thinking: off" : `Think: ${l}`}</option>`).join("");
    thinkingSelect.value = current;
    thinkingSelect.disabled = levels.length < 2;
    thinkingSelect.title = levels.length < 2 ? "This model has no adjustable thinking effort" : "Thinking effort";
  }

  if (data.model !== lastModel) {
    lastModel = data.model;
    window.loadModels?.();
  }
}

function render() {
  const started = performance.now();
  renderNow();
  window.__perf?.render(performance.now() - started);
}

function renderNow() {
  frame = 0;
  if (!payload) return;
  const sessionId = payload.session?.id ?? null;
  if (sessionId !== renderedSessionId) {
    renderedSessionId = sessionId;
    lastHistoryKey = null;
    historyHasContent = false;
    historyEl.replaceChildren();
    dynamicEl.replaceChildren();
    tailState.slots = [];
    historyState.slots = [];
    firstSeen.clear();
    freshEls.clear();
    bodyScrollTop.clear();
    unpinnedBodies.clear();
    userOpen.clear();
    userClosed.clear();
    glides.clear();
    if (glideFrame) {
      cancelAnimationFrame(glideFrame);
      glideFrame = 0;
    }
  }

  renderMessages(payload.view, sessionId);
  if (statsDirty) {
    renderStats(payload.view);
    statsDirty = false;
  }
  if (controlsDirty) {
    renderControls(payload);
    controlsDirty = false;
  }
  const sessionInfo = JSON.stringify(payload.session || null);
  if (sessionInfo !== lastSessionInfo) {
    lastSessionInfo = sessionInfo;
    window.onSessionInfo?.(payload.session);
  }
}

window.onAgentView = (data) => {
  payload = data;
  statsDirty = true;
  controlsDirty = true;
  if (!frame) frame = requestAnimationFrame(render);
};

/** The server sent only what was appended to the streaming text; stitch it onto what we hold. */
function applyLiveDelta(current, live, rev, base) {
  if (!live?.delta) return live;
  // Deltas build on the revision the server last sent. If one was missed (or this page holds a
  // different partial) the stitched text would be wrong, so ask for a full snapshot instead.
  if (base !== payload.rev) return undefined;
  const before = current.live?.blocks || [];
  return {
    blocks: live.blocks.map((b, i) => {
      if (b.append === undefined) return b;
      const { append, ...rest } = b;
      return { ...rest, text: (before[i]?.text ?? "") + append };
    }),
  };
}

window.onAgentUpdate = (data) => {
  if (!payload || !data?.view) return; // a full snapshot arrives first on each connection
  const current = payload.view;
  const update = data.view;
  const live = update.live == null ? undefined : update.live;
  const stitched = applyLiveDelta(current, live, data.rev, data.base);
  if (live?.delta && !stitched) {
    window.requestResync?.();
    return;
  }
  payload.rev = data.rev;
  current.live = stitched;
  current.tools = Array.isArray(update.tools) ? update.tools : [];
  current.busy = Boolean(update.busy);
  current.runStartedAt = update.runStartedAt == null ? undefined : update.runStartedAt;
  current.queue = Array.isArray(update.queue) ? update.queue : [];
  if (update.toolViews) current.toolViews = update.toolViews;
  if (data.thinking) payload.thinking = data.thinking;
  if (typeof data.model === "string") payload.model = data.model;
  if (data.session) payload.session = data.session;
  controlsDirty = true;
  if (!frame) frame = requestAnimationFrame(render);
};
window.scrollChatToBottom = () => glideTo(messagesEl, messagesEl.scrollHeight, MOVE_TAU);

/* ---------- interaction ---------- */

// Remember what the user opens or closes so streaming re-renders don't undo it.
function updateComposerAction() {
  const hasDraft = Boolean(chatInput.value.trim() || pendingImages.length);
  const stopping = Boolean(payload?.view?.busy && !hasDraft);
  const action = stopping ? "stop" : "send";
  if (sendBtn.dataset.action !== action) {
    sendBtn.dataset.action = action;
    sendBtn.innerHTML = icon(stopping ? "square" : "send", stopping ? 16 : 19);
  }
  if (sendBtn.classList.contains("stop-btn") !== stopping) sendBtn.classList.toggle("stop-btn", stopping);
  if (sendBtn.title !== (stopping ? "Stop the current run" : "Send (queues while the agent is busy)")) {
    sendBtn.title = stopping ? "Stop the current run" : "Send (queues while the agent is busy)";
    sendBtn.setAttribute("aria-label", stopping ? "Stop current run" : "Send message");
  }
  const disabled = attachmentUploadInProgress && !stopping;
  if (sendBtn.disabled !== disabled) sendBtn.disabled = disabled;
}

messagesEl.addEventListener("click", (e) => {
  const summary = e.target.closest("summary");
  const details = summary?.parentElement;
  if (!details?.dataset.key) return;
  const key = details.dataset.key;
  if (details.open) { userOpen.delete(key); userClosed.add(key); } // about to close
  else { userClosed.delete(key); userOpen.add(key); }              // about to open
});

// Enter is a newline in the textarea (that is the point of it); a hardware keyboard
// still needs a way to send without the finger, so Ctrl/Cmd+Enter submits the form.
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
    e.preventDefault();
    chatForm.requestSubmit ? chatForm.requestSubmit() : chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (payload?.view?.busy && !chatInput.value.trim() && !pendingImages.length) {
    fetch("/api/abort", { method: "POST" }).catch(() => {});
    return;
  }
  if (attachmentUploadInProgress) return;
  const text = chatInput.value.trim();
  const images = pendingImages.map(({ path, number, name }) => ({ path, label: `Image #${number}`, name }));
  if (!text && !images.length) return;
  chatInput.value = "";
  autoSizeChatInput();
  for (const image of pendingImages) URL.revokeObjectURL(image.previewUrl);
  pendingImages.length = 0;
  nextImageNumber = 1;
  renderAttachmentTray();
  updateComposerAction();
  sendText(text, images);
});

// The reply arrives through the live view; this request only reports immediate failures.
function sendText(text, attachments = []) {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, attachments }),
  }).then(r => r.json()).then(d => { if (d.error) alert(d.error); }).catch(() => {});
}

/* ---------- attachments ----------
   Android gives the WebView a content:// URI for picked files; upload the bytes here, then
   keep image paths as structured request metadata while the composer shows removable previews
   and stable [Image #N] references. Non-image attachments retain the path-in-prompt workflow. */
const attachBtn = document.getElementById("attach-btn");
const attachInput = document.getElementById("attach-input");
const attachmentTray = document.getElementById("attachment-tray");
const pendingImages = [];
let nextImageNumber = 1;
let attachmentUploadInProgress = false;

/* ---------- composer field sizing ----------
   A textarea instead of a single-line input, so Enter on the soft keyboard types a newline
   (and long text wraps rather than scrolling sideways). The box then has to grow with the
   draft, up to a cap: past the cap it scrolls vertically like any other text field, which
   is why .tall flips touch-action so a vertical drag scrolls the field instead of being
   swallowed by the chrome touch guard. The cap is a share of the *visual* viewport, so it
   shrinks sensibly once the keyboard is up (CSS vh is the layout viewport and ignores it). */
function autoSizeChatInput() {
  const line = parseFloat(getComputedStyle(chatInput).lineHeight) || 20;
  const viewportH = window.visualViewport?.height || window.innerHeight || 640;
  const max = Math.max(line * 3, Math.round(viewportH * 0.3));
  chatInput.style.height = "auto";
  // scrollHeight is the content height even while the box is clamped, so it still tells
  // us whether the field overflows.
  const overflowing = chatInput.scrollHeight > max + 1;
  chatInput.style.maxHeight = `${max}px`;
  chatInput.style.height = `${overflowing ? max : chatInput.scrollHeight}px`;
  chatInput.classList.toggle("tall", overflowing);
}

chatInput.addEventListener("input", () => {
  autoSizeChatInput();
  updateComposerAction();
});
// The keyboard opening or closing changes the cap.
window.visualViewport?.addEventListener("resize", autoSizeChatInput);
window.addEventListener("resize", autoSizeChatInput);
autoSizeChatInput(); // settle the empty field to exactly one line
updateComposerAction();

function isSupportedImage(file) {
  return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(file.type || "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || "");
}

function renderAttachmentTray() {
  if (!attachmentTray) return;
  attachmentTray.replaceChildren();
  for (const image of pendingImages) {
    const card = document.createElement("div");
    card.className = "attachment-preview";
    card.setAttribute("role", "listitem");
    card.title = `Image #${image.number}: ${image.name}`;

    const preview = document.createElement("img");
    preview.src = image.previewUrl;
    preview.alt = `Image #${image.number}: ${image.name}`;
    card.append(preview);

    const label = document.createElement("span");
    label.className = "attachment-number";
    label.textContent = `Image #${image.number}`;
    card.append(label);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.title = `Remove Image #${image.number}`;
    remove.setAttribute("aria-label", `Remove Image #${image.number}`);
    remove.addEventListener("click", () => {
      const index = pendingImages.indexOf(image);
      if (index < 0) return;
      pendingImages.splice(index, 1);
      URL.revokeObjectURL(image.previewUrl);
      removeImageReference(image.number);
      renderAttachmentTray();
    });
    card.append(remove);
    attachmentTray.append(card);
  }
  attachmentTray.hidden = pendingImages.length === 0;
  if (!attachmentUploadInProgress) updateComposerAction();
}

function removeImageReference(number) {
  const marker = `[Image #${number}]`;
  chatInput.value = chatInput.value.split(marker).join("").replace(/ {2,}/g, " ").trim();
  autoSizeChatInput();
}

if (attachBtn && attachInput) {
  attachBtn.addEventListener("click", () => attachInput.click());

  attachInput.addEventListener("change", async () => {
    const files = [...attachInput.files];
    attachInput.value = ""; // so picking the same file again still fires change
    if (!files.length) return;
    attachBtn.disabled = true;
    attachmentUploadInProgress = true;
    updateComposerAction();
    const savedPaths = [];
    const addedMarkers = [];
    try {
      for (const file of files) {
        const imageFile = isSupportedImage(file);
        if (imageFile && file.size > 8 * 1024 * 1024) { alert(`${file.name} is larger than 8 MB.`); break; }
        if (imageFile && pendingImages.length >= 8) { alert("Attach no more than 8 images in one message."); break; }
        const queuedBytes = pendingImages.reduce((total, image) => total + image.size, 0);
        if (imageFile && queuedBytes + file.size > 32 * 1024 * 1024) { alert("Attached images must total 32 MB or less."); break; }
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        const data = await res.json();
        if (data.error) { alert(data.error); break; }
        if (isSupportedImage(file)) {
          const number = nextImageNumber++;
          pendingImages.push({ path: data.path, name: file.name, size: file.size, number, previewUrl: URL.createObjectURL(file) });
          addedMarkers.push(`[Image #${number}]`);
          renderAttachmentTray();
        } else {
          savedPaths.push(data.path);
        }
      }
    } catch (err) {
      alert(`Upload failed: ${err}`);
    } finally {
      attachBtn.disabled = false;
      attachmentUploadInProgress = false;
      updateComposerAction();
    }
    if (savedPaths.length) appendToComposer(savedPaths.join("\n"));
    if (addedMarkers.length) appendToComposer(addedMarkers.join(" "));
  });
}

/* Put a reference at the end of the composer and leave the caret there. */
function appendToComposer(text) {
  const current = chatInput.value.trim();
  chatInput.value = current ? `${current} ${text}` : text;
  autoSizeChatInput();
  updateComposerAction();
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}

thinkingSelect.addEventListener("change", async () => {
  try {
    const res = await fetch("/api/thinking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: thinkingSelect.value }),
    });
    const data = await res.json();
    if (data.error) alert(data.error);
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- branching ----------
   A branch is a whole session, so the affordance hangs off a message: a long press (or a right click
   on desktop) opens a small menu at that message listing the branch points the server marked on it.
   The gesture is deliberately provisional — it is the one thing here worth judging on the device.

   The menu is a fixed element on <body>, for the same reason the session row menu is: it has to
   escape the message list's stacking context and be clamped to the viewport on a narrow phone. */
const LONG_PRESS_MS = 480;
let branchMenu = null;
let pressTimer = 0;
let press = null;

function closeBranchMenu() {
  if (!branchMenu || branchMenu.hidden) return;
  branchMenu.hidden = true;
  branchMenu.innerHTML = "";
}

/* What can be branched from this element, in the order they should be offered. */
function branchItemsFor(el) {
  const items = [];
  if (el.dataset.branchAfter)
    items.push({ at: Number(el.dataset.branchAfter), icon: "git-compare", label: "Branch from here", hint: "keeps everything up to this answer" });
  if (el.dataset.branchBefore)
    items.push({ at: Number(el.dataset.branchBefore), icon: "rotate-ccw", label: "Branch before this", hint: "starts again from the message above" });
  return items;
}

function openBranchMenu(anchor) {
  const items = branchItemsFor(anchor);
  if (!items.length) return;
  if (!branchMenu) {
    branchMenu = document.createElement("div");
    branchMenu.className = "branch-menu";
    branchMenu.setAttribute("role", "menu");
    branchMenu.hidden = true;
    document.body.appendChild(branchMenu);
  }
  branchMenu.innerHTML = items.map(it => `
    <button type="button" class="branch-menu-item" role="menuitem" data-at="${it.at}">
      ${icon(it.icon, 16)}<span class="branch-label">${escapeHtml(it.label)}</span><span class="branch-hint">${escapeHtml(it.hint)}</span>
    </button>`).join("");
  branchMenu.hidden = false;

  // Sit beside the message: clamped inside the viewport, and centred on it when it is wide enough that
  // an edge-aligned menu would fall off a phone screen.
  const r = anchor.getBoundingClientRect();
  const m = branchMenu.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(r.left + r.width / 2 - m.width / 2, window.innerWidth - m.width - pad));
  const below = r.bottom + 6;
  const top = below + m.height > window.innerHeight - pad ? Math.max(pad, r.top - m.height - 6) : below;
  branchMenu.style.left = `${left}px`;
  branchMenu.style.top = `${top}px`;
  navigator.vibrate?.(12);
  branchMenu.querySelector("button")?.focus({ preventScroll: true });
}

function cancelPress() {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = 0;
  press = null;
}

messagesEl.addEventListener("pointerdown", (e) => {
  // Inside a summary, a scrollable body, a link or the queued-message row a tap already means
  // something else, so a long press there must not turn into a menu.
  if (e.target.closest("summary, .think-body, .tool-body, .tool-out, a, button")) return;
  const el = e.target.closest("[data-branch-after], [data-branch-before]");
  if (!el) return;
  press = { x: e.clientX, y: e.clientY, el };
  pressTimer = setTimeout(() => {
    pressTimer = 0;
    const held = press;
    press = null;
    if (held) openBranchMenu(held.el);
  }, LONG_PRESS_MS);
});
// A finger that moves is a scroll or a selection, not a long press.
messagesEl.addEventListener("pointermove", (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
}, { passive: true });
messagesEl.addEventListener("pointerup", cancelPress);
messagesEl.addEventListener("pointercancel", cancelPress);
messagesEl.addEventListener("scroll", closeBranchMenu, { passive: true });
messagesEl.addEventListener("contextmenu", (e) => {
  const el = e.target.closest("[data-branch-after], [data-branch-before]");
  if (!el) return;
  e.preventDefault();
  openBranchMenu(el);
});

// The server answers with the new session already switched to, so the pushed view and the session
// list update on their own.
async function branchAt(at) {
  const id = payload?.session?.id;
  if (id === undefined) return;
  try {
    await sessionsApi("/api/sessions/fork", "POST", { id, at });
  } catch (e) {
    alert(e.message);
  }
}

document.addEventListener("click", (e) => {
  const item = e.target.closest(".branch-menu-item");
  if (!item || !branchMenu || branchMenu.hidden) return;
  const at = Number(item.dataset.at);
  closeBranchMenu();
  branchAt(at);
});
// Dismiss on a tap anywhere else, on Escape, and on a resize.
document.addEventListener("pointerdown", (e) => {
  if (!branchMenu || branchMenu.hidden) return;
  if (branchMenu.contains(e.target)) return;
  closeBranchMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBranchMenu();
});
window.addEventListener("resize", closeBranchMenu);
// The menu is a layer of its own: Android back closes it before anything else.
registerBackLayer(95, () => branchMenu && !branchMenu.hidden, closeBranchMenu);
