// Chat: renders the live agent view (streaming thinking, tool calls, queue, context + cache stats).
// The server pushes a compact view over the WebSocket after every committed change.

const messagesEl = document.getElementById("messages-container");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const stopBtn = document.getElementById("stop-btn");
const queueBar = document.getElementById("queue-bar");
const ctxLabel = document.getElementById("ctx-label");
const ctxFill = document.getElementById("ctx-fill");
const cacheLabel = document.getElementById("cache-label");
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
    if (first !== undefined) return String(typeof first === "string" ? first : JSON.stringify(first)).replace(/\s+/g, " ").slice(0, 90);
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
  const outputHtml = output ? toolLabel("output") + `<pre class="code tool-out">${escapeHtml(output)}</pre>` : "";

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

function thinkingBlock(key, text, streaming) {
  const open = isOpen(key, streaming);
  const body = escapeHtml(text) || "…";
  return `
    <details class="think" data-key="${key}" ${open ? "open" : ""}>
      <summary>${streaming ? '<span class="shimmer">Thinking…</span>' : `${icon("brain", 13, "ico-inline")} Thought`}</summary>
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
    <details class="tool${failed ? " failed" : ""}" data-key="${key}" ${isOpen(key, false) ? "open" : ""}>
      <summary>
        <span class="tool-ico">${icon(toolIcon(call.name), 14)}</span>
        <span class="tool-name">${escapeHtml(call.name)}</span>
        <span class="tool-sum">${escapeHtml(toolSummary(call.name, args))}</span>
        ${status}
      </summary>
      <div class="tool-body">${toolBodyHtml(call, args, output)}</div>
    </details>`;
}

function assistantHtml(idKey, blocks, live, results, tools, error) {
  const body = blocks.map((b, i) => {
    const key = `${idKey}-${i}`;
    if (b.type === "thinking") {
      // Streaming thinking stays open only while it is the block being written.
      return thinkingBlock(key, b.text, live && i === blocks.length - 1);
    }
    if (b.type === "toolCall") return toolBlock(`t-${b.id}`, b, tools.get(b.id), results.get(b.id));
    // Committed text arrives pre-rendered from the server (chatview.ts); the streaming
    // partial has no html yet, so it is rendered here.
    if (!b.text.trim()) return "";
    const html = b.html ?? md(b.text);
    return `<div class="message assistant"><div class="message-content">${html}</div></div>`;
  }).join("");
  const err = error ? `<div class="message assistant error"><div class="message-content">${escapeHtml(error)}</div></div>` : "";
  return `<div class="turn">${body}${err}</div>`;
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
      html.push(`<div class="message user"><div class="message-content">${escapeHtml(m.text)}</div></div>`);
    } else if (m.role === "assistant") {
      const error = m.stop === "error" || m.stop === "aborted" ? (m.error || (m.stop === "aborted" ? "Stopped" : "")) : "";
      html.push(assistantHtml(`m${m.id}`, m.blocks || [], false, results, tools, error));
    }
  }
  if (view.live?.blocks?.length) html.push(assistantHtml("live", view.live.blocks, true, results, tools, ""));
  else if (view.busy) html.push('<div class="message assistant thinking"><div class="message-content"><span class="shimmer">Working…</span></div></div>');

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
}

function renderStats(view) {
  const s = view.stats;
  if (s.contextWindow > 0) {
    const pct = Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100));
    ctxLabel.textContent = `Ctx ${fmtTokens(s.contextTokens)}/${fmtTokens(s.contextWindow)} · ${pct}%`;
    ctxFill.style.width = `${pct}%`;
    ctxFill.className = `meter-fill ${pct >= 90 ? "hot" : pct >= 70 ? "warm" : ""}`;
  } else {
    ctxLabel.textContent = "Ctx –";
    ctxFill.style.width = "0";
  }
  cacheLabel.textContent = s.cacheLast === undefined ? "Cache –" : `Cache ${s.cacheLast}%`;
  cacheLabel.title = s.cacheSession === undefined ? "Prompt cache hit rate"
    : `Prompt cache hit rate: ${s.cacheLast}% last request, ${s.cacheSession}% over this conversation${s.cost ? ` · $${s.cost.toFixed(4)} spent` : ""}`;
}

function renderControls(data) {
  const view = data.view;
  stopBtn.hidden = !view.busy;
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
messagesEl.addEventListener("click", (e) => {
  const summary = e.target.closest("summary");
  const details = summary?.parentElement;
  if (!details?.dataset.key) return;
  const key = details.dataset.key;
  if (details.open) { userOpen.delete(key); userClosed.add(key); } // about to close
  else { userClosed.delete(key); userOpen.add(key); }              // about to open
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  sendText(text);
});

// The reply arrives through the live view; this request only reports immediate failures.
function sendText(text) {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  }).then(r => r.json()).then(d => { if (d.error) alert(d.error); }).catch(() => {});
}

/* ---------- attachments ----------
   The file picker is the only way a file from this phone can reach the agent: Android hands
   the WebView a content:// URI for it, so the bytes can be read without any storage
   permission, and the server stores them under uploads/ itself. That matters because shared
   storage is readable only for files this app created -- a screenshot or download made by
   another app comes back EACCES no matter what its permissions say.

   The upload is not a message of its own: it only drops the saved paths into the composer and
   waits. The user still decides what to ask about them, and can delete a path or add a question
   before sending, instead of a turn landing on its own with "read this from the workspace". */
const attachBtn = document.getElementById("attach-btn");
const attachInput = document.getElementById("attach-input");

if (attachBtn && attachInput) {
  attachBtn.addEventListener("click", () => attachInput.click());

  attachInput.addEventListener("change", async () => {
    const files = [...attachInput.files];
    attachInput.value = ""; // so picking the same file again still fires change
    if (!files.length) return;
    attachBtn.disabled = true;
    const saved = [];
    try {
      for (const file of files) {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        const data = await res.json();
        if (data.error) { alert(data.error); break; }
        saved.push(data.path);
      }
    } catch (err) {
      alert(`Upload failed: ${err}`);
    } finally {
      attachBtn.disabled = false;
    }
    if (saved.length) appendToComposer(saved.join("\n"));
  });
}

/* Put text at the end of the composer, on its own line when the user already wrote something,
   and leave the caret there -- so the next thing typed continues the same thought and nothing
   is sent until the user hits send. */
function appendToComposer(text) {
  const current = chatInput.value.trim();
  chatInput.value = current ? `${current}\n${text}` : text;
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}

stopBtn.addEventListener("click", () => fetch("/api/abort", { method: "POST" }).catch(() => {}));

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
