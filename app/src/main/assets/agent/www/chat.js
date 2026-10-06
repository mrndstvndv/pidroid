// Chat: renders the live agent view (streaming thinking, tool calls, queue, context + cache stats).
// The server pushes a compact view over the WebSocket after every committed change.

const messagesEl = document.getElementById("messages-container");
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
let lastRendered = "";
let lastModel = "";
let frame = 0;

// renderMessages() replaces the whole list, so the shimmer text and the tool spinner are
// new elements each time and their CSS animation would restart from 0 — with a streaming
// update arriving many times a second the cycle never completes and the animation looks
// frozen. The phase below is stamped on the container (which survives the re-render) and
// style.css turns it into a negative animation-delay, so every fresh element resumes the
// cycle where the previous one was. It must never wrap: a wrap point that is not a whole
// number of cycles (0.8s spin, 1.6s shimmer) would jump the animation.
const ANIM_PHASE_STEP = 0.05; // s; anything well under a frame looks continuous
let lastPhase = "";

/* ---------- streaming text ----------
   Streamed text renders in one piece, at full opacity: the list is rebuilt every frame, so
   anything that tracked a character's age would need per-character inline styles on every
   pass. A long thought instead fades at the edges of its box (`.think-body.overflowing`
   in style.css), which survives the re-render because it is plain CSS on the container.
   Rendering in one piece also means a markdown construct written across several frames is
   no longer cut in half mid-parse. */

/* ---------- sticky inner scroll ----------
   Thinking bodies and tool outputs scroll on their own. Re-rendering resets scrollTop to
   0, which left a streaming block frozen at its first line, so open bodies are pushed
   back to the bottom — unless the user scrolled up inside one, in which case that
   position is remembered and restored instead (otherwise reading back is impossible while
   the agent keeps writing). */
const unpinnedBodies = new Set();
const bodyScrollTop = new Map();

function bodyKey(el) {
  return el.closest("details[data-key]")?.dataset.key;
}

messagesEl.addEventListener("scroll", (e) => {
  const body = e.target?.closest?.(".think-body, .tool-out");
  const key = body && bodyKey(body);
  if (!key) return;
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 24) {
    unpinnedBodies.delete(key);
    bodyScrollTop.delete(key);
  } else {
    unpinnedBodies.add(key);
    bodyScrollTop.set(key, body.scrollTop);
  }
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

/** Only the running spans are touched, and only while something is running. */
function tickDurations() {
  const now = Date.now();
  let live = false;
  messagesEl.querySelectorAll(".dur-live[data-since]").forEach((el) => {
    el.textContent = fmtDur(now - Number(el.dataset.since));
    live = true;
  });
  if (live !== ticking) {
    ticking = live;
    clearInterval(durTimer);
    if (live) durTimer = setInterval(tickDurations, 1000);
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

function toolSummary(name, args) {
  if (args && typeof args === "object") {
    const first = args.command ?? args.path ?? args.file_path ?? Object.values(args)[0];
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

/** The expanded body of a tool call: a real preview where there is one, JSON otherwise. */
function toolBodyHtml(call, args, output) {
  const outputHtml = call.name !== "edit" && output ? toolLabel("output") + `<pre class="code tool-out">${escapeHtml(output)}</pre>` : "";

  if (call.name === "web_search" && typeof output === "string") {
    // The cards carry everything the raw text did -- title, host, date, excerpt -- so keeping the
    // dump underneath would just be the same results twice. Only when the cards cannot be built (a
    // provider error, or output from before this renderer existed) does the text stay, because then
    // it is the only copy of what happened.
    const results = webSearchPreview(output);
    if (results) return results;
  }

  let preview = "";
  if (call.name === "edit") preview = editPreview(args);
  else if (call.name === "write" && typeof args.content === "string") preview = writePreview(args);
  if (preview) return preview + outputHtml;

  const isBash = call.name === "bash" && typeof args.command === "string";
  const argsText = isBash ? args.command : JSON.stringify(args, null, 2);
  return toolLabel(isBash ? "command" : "arguments") + `<pre class="code">${escapeHtml(argsText)}</pre>` + outputHtml;
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
  return `
    <details class="tool${failed ? " failed" : ""}${call.name === "edit" ? " edit-tool" : ""}" data-key="${key}" ${isOpen(key, call.name === "web_search" || call.name === "edit") ? "open" : ""}>
      <summary>
        <span class="tool-ico">${icon(toolIcon(call.name), 14)}</span>
        <span class="tool-name">${escapeHtml(call.name)}</span>
        <span class="tool-sum">${escapeHtml(toolSummary(call.name, args))}</span>
        ${running ? durHtml(undefined, call.at) : durHtml(call.ms, undefined)}
        ${status}
      </summary>
      <div class="tool-body">${toolBodyHtml(call, args, output)}</div>
    </details>`;
}

function assistantHtml(idKey, blocks, live, results, tools, error, ms, branchAfter) {
  const body = blocks.map((b, i) => {
    const key = `${idKey}-${i}`;
    if (b.type === "thinking") {
      // Streaming thinking stays open only while it is the block being written.
      return thinkingBlock(key, b, live && i === blocks.length - 1);
    }
    if (b.type === "toolCall") return toolBlock(`t-${b.id}`, b, tools.get(b.id), results.get(b.id));
    // Committed text arrives pre-rendered from the server (chatview.ts); the streaming
    // partial has no html yet, so it is rendered here.
    if (!b.text.trim()) return "";
    const html = b.html ?? md(b.text);
    return `<div class="message assistant"><div class="message-content">${html}</div></div>`;
  }).join("");
  const err = error ? `<div class="message assistant error"><div class="message-content">${escapeHtml(error)}</div></div>` : "";
  // One dim line per assistant message: how long the model took to think it through and write
  // it. Tool calls carry their own durations on their rows.
  const meta = live || ms === undefined ? "" : `<div class="message-meta">${iconTag("clock", 12, "dim")} Worked ${fmtDur(ms)}</div>`;
  // data-branch-after is the entry to branch at for a session starting just after this answer. It is
  // only set when the server marked the message as a valid branch point (no unanswered tool calls).
  const fork = branchAfter === undefined ? "" : ` data-branch-after="${branchAfter}"`;
  return `<div class="turn"${fork}>${body}${err}${meta}</div>`;
}

function stampAnimPhase() {
  const phase = (Math.round(performance.now() / 1000 / ANIM_PHASE_STEP) * ANIM_PHASE_STEP).toFixed(2);
  if (phase === lastPhase) return;
  lastPhase = phase;
  messagesEl.style.setProperty("--anim-phase", `${phase}s`);
}

function renderMessages(view) {
  const results = new Map(view.messages.filter(m => m.role === "tool").map(m => [m.callId, m]));
  const tools = new Map(view.tools.map(t => [t.callId, t]));
  const html = [];

  for (const m of view.messages) {
    if (m.role === "user") {
      // data-branch-before points at the entry ahead of this prompt, so a new session can start there
      // and replay it. Absent on the first message of a conversation, which has nothing before it.
      const fork = m.branchBefore === undefined ? "" : ` data-branch-before="${m.branchBefore}"`;
      html.push(`<div class="message user"${fork}><div class="message-content">${escapeHtml(m.text)}</div></div>`);
    } else if (m.role === "assistant") {
      const error = m.stop === "error" || m.stop === "aborted" ? (m.error || (m.stop === "aborted" ? "Stopped" : "")) : "";
      html.push(assistantHtml(`m${m.id}`, m.blocks || [], false, results, tools, error, m.ms, m.branchAfter));
    }
  }
  if (view.live?.blocks?.length) html.push(assistantHtml("live", view.live.blocks, true, results, tools, ""));
  else if (view.busy) {
    const since = view.runStartedAt ? durHtml(undefined, view.runStartedAt) : "";
    html.push(`<div class="message assistant thinking"><div class="message-content"><span class="shimmer">Working…</span>${since}</div></div>`);
  }

  for (const q of view.queue) {
    html.push(`<div class="message user queued"><div class="message-content">${escapeHtml(q.text)}</div><div class="message-meta">${iconTag("clock", 12, "dim")} queued · sends after the current step</div></div>`);
  }
  if (!html.length) html.push('<p class="description empty">Give the agent a task. It can read, write and edit its own UI and files, and run commands.</p>');

  stampAnimPhase();
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  messagesEl.innerHTML = html.join("");
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  messagesEl.querySelectorAll("details[data-key] .think-body, details[data-key] .tool-out").forEach((el) => {
    const key = bodyKey(el);
    el.scrollTop = key && unpinnedBodies.has(key) ? (bodyScrollTop.get(key) ?? 0) : el.scrollHeight;
    // The edge fade only means something when there is text past the edge; a short thought
    // must stay fully readable.
    if (el.classList.contains("think-body")) el.classList.toggle("overflowing", el.scrollHeight - el.clientHeight > 2);
  });
  tickDurations();
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
  if (view.queue.length) {
    queueBar.hidden = false;
    queueBar.innerHTML = `${iconTag("clock", 13)} ${view.queue.length} message${view.queue.length > 1 ? "s" : ""} queued`;
  } else {
    queueBar.hidden = true;
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
  frame = 0;
  if (!payload) return;
  const text = JSON.stringify(payload);
  if (text === lastRendered) return;
  lastRendered = text;
  renderMessages(payload.view);
  renderStats(payload.view);
  renderControls(payload);
  window.onSessionInfo?.(payload.session);
}

window.onAgentView = (data) => {
  payload = data;
  if (!frame) frame = requestAnimationFrame(render);
};
window.scrollChatToBottom = () => (messagesEl.scrollTop = messagesEl.scrollHeight);

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
  sendBtn.classList.toggle("stop-btn", stopping);
  sendBtn.title = stopping ? "Stop the current run" : "Send (queues while the agent is busy)";
  sendBtn.setAttribute("aria-label", stopping ? "Stop current run" : "Send message");
  sendBtn.disabled = attachmentUploadInProgress && !stopping;
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
