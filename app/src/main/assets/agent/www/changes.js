// Changes tab: browse agent checkpoints, view diffs, undo / restore.
// colorDiff() lives in app.js (loaded first) and is shared with the chat's tool preview.

const changesList = document.getElementById("changes-list");
let entries = [];
const open = new Set();

async function changesApi(path, method = "GET") {
  const res = await fetch(path, method === "GET" ? {} : { method, headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const KIND_LABEL = { init: "shipped", external: "external", edits: "manual", turn: "agent", update: "update", undo: "undo" };

async function loadChanges() {
  loadUpdate();
  try {
    entries = (await changesApi("/api/changes")).entries;
    renderChanges();
  } catch (e) {
    changesList.innerHTML = `<p>Error loading changes: ${escapeHtml(e.message)}</p>`;
  }
}
window.loadChanges = loadChanges;

/* ---------- app update ----------
   The app shipped a new bundle that changes files the agent has also changed. Nothing from the update is applied
   until the user picks one of three answers; the server holds the state and these buttons are its answers. Merge
   opens a session that runs the shipped agent, which resolves the files and calls complete_merge. */
const updatePanel = document.getElementById("update-panel");

async function loadUpdate() {
  try {
    renderUpdate(await changesApi("/api/update"));
  } catch {
    updatePanel.hidden = true;
  }
}

function renderUpdate(status) {
  updatePanel.hidden = !status.stage;
  if (!status.stage) {
    updatePanel.innerHTML = "";
    return;
  }
  const files = status.conflicts.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("");
  if (status.stage === "merging") {
    updatePanel.innerHTML = `
      <h3>Merging app update ${escapeHtml(status.stamp ?? "")}</h3>
      <p>A merge session is resolving these files. Finish it there; it calls complete_merge when every file is done.</p>
      <ul>${files}</ul>
      <div class="provider-actions">
        <button class="btn-secondary" data-update="cancel">Cancel merge</button>
      </div>
      <p class="description">Cancelling saves the merge's work as an edit in the history, then asks for a choice again.</p>`;
    return;
  }
  updatePanel.innerHTML = `
    <h3>App update ${escapeHtml(status.stamp ?? "")}</h3>
    <p>This update changes files the agent has also changed. Until you choose, none of the update is applied.</p>
    <ul>${files}</ul>
    <div class="provider-actions">
      <button class="btn-secondary" data-update="keep">Keep mine</button>
      <button class="btn-secondary" data-update="bundled">Use bundled</button>
      <button class="btn-primary" data-update="merge">Merge in a session</button>
    </div>
    <p class="description">Keep mine and Use bundled decide only the files above; the rest of the update is applied either way. Merge opens a session running the shipped agent, which combines the two versions of each file.</p>`;
}

updatePanel.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-update]");
  if (!btn) return;
  btn.disabled = true;
  try {
    if (btn.dataset.update === "merge") {
      const begun = await changesApi("/api/update/merge", "POST");
      await newSession(); // sessions.js: creates a session and switches to it
      await sendText(begun.prompt); // chat.js: the merge session's first message
      showScreen("chat");
    } else {
      await changesApi(`/api/update/${btn.dataset.update}`, "POST");
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    loadChanges();
  }
});

function renderChanges() {
  changesList.innerHTML = entries.map((e, i) => `
    <div class="change-item" data-oid="${e.oid}">
      <button class="change-head" data-act="toggle">
        <span class="change-title">
          <strong>${escapeHtml(e.summary || "(no message)")}</strong>
          <span class="provider-meta">${ago(e.timestamp)}${i === 0 ? " · latest" : ""}</span>
        </span>
        <span class="change-kind ${e.kind}">${KIND_LABEL[e.kind] || e.kind}</span>
      </button>
      ${open.has(e.oid) ? `<div class="change-body" id="body-${e.oid}"><p class="provider-meta">Loading files...</p></div>` : ""}
    </div>`).join("") || "<p>No changes yet.</p>";
  open.forEach(loadFiles);
}

/* ---------- diff rendering ----------
   The server sends rows already carrying line numbers and tokenised HTML (see diffrows.ts), so
   this side only has to decide how a row looks: two gutters (old and new line number), a change
   marker, and the content. Rows the server could not colour fall back to escaped plain text, and a
   patch that could not be tokenised at all falls back to the old colorDiff() rendering. */

const MARK = { add: "+", del: "−", ctx: " " };

/**
 * One row's markup. `index` is its position in the stored row list, which is what makes a fold
 * placeholder expandable: the hidden rows ride along with the placeholder, so tapping it splices
 * them back into that same array and the block re-renders. No second request, no refetch.
 */
function diffRowHtml(r, index) {
  if (r.kind === "meta") {
    if (r.folded || r.count > 0) {
      return `<button type="button" class="code-fold" data-index="${index}"><span class="code-ln">⋯</span>` +
        `<span class="code-lc">Show ${escapeHtml(r.text)}</span></button>`;
    }
    return `<span class="code-row is-meta"><span class="code-ln"></span><span class="code-lc">${escapeHtml(r.text)}</span></span>`;
  }
  const content = r.html != null ? r.html : escapeHtml(r.text);
  return `<span class="code-row is-${r.kind}">` +
    `<span class="code-ln code-ln-pair"><span class="is-old">${r.oldNo ?? ""}</span><span class="is-new">${r.newNo ?? ""}</span></span>` +
    `<span class="code-mk">${MARK[r.kind] ?? " "}</span>` +
    `<span class="code-lc">${content}</span></span>`;
}

function paintDiff(pre) {
  window.CodeView.surface(pre, { wrap: window.CodeView.prefersWrap(), highlighted: true });
  pre.innerHTML = pre._rows.map(diffRowHtml).join("");
}

function renderDiff(pre, data) {
  const rows = Array.isArray(data.rows) && data.rows.length ? data.rows : null;
  if (!rows) {
    // Nothing tokenised: the patch itself, coloured the old way.
    pre.className = "diff";
    pre.innerHTML = colorDiff(data.patch || "");
    pre._rows = null;
    return;
  }
  pre.className = "diff code-block";
  // The patch is built with the whole file as context, so it is one hunk from line 1, and its
  // "@@ -1,202 +1,204 @@" says nothing the gutter does not. Real hunk headings (several hunks, or
  // one starting further down) stay: there they mark a jump.
  const hunks = rows.filter((r) => r.kind === "meta" && r.text.startsWith("@@"));
  pre._rows = hunks.length === 1 && rows[0] === hunks[0] && /^@@ -[01](,\d+)? \+[01](,\d+)? @@/.test(hunks[0].text)
    ? rows.slice(1)
    : rows;
  paintDiff(pre);
}

function statsLabel(data) {
  if (data.added == null && data.removed == null) return "";
  return `<span class="diff-stat"><span class="add">+${data.added || 0}</span> <span class="del">−${data.removed || 0}</span></span>`;
}

async function loadFiles(oid) {
  const body = document.getElementById(`body-${oid}`);
  if (!body) return;
  try {
    const { files } = await changesApi(`/api/changes/${oid}/files`);
    const entry = entries.find(e => e.oid === oid);
    const undoable = entry && entry.kind !== "init";
    body.innerHTML = `
      ${entry?.detail ? `<p class="provider-meta">${escapeHtml(entry.detail)}</p>` : ""}
      ${files.map(f => `
        <details class="change-file" data-path="${escapeHtml(f.path)}">
          <summary><span class="st-${f.status}">${f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~"}</span> ${escapeHtml(f.path)}<span class="change-file-stat" data-stat="${escapeHtml(f.path)}"></span><button type="button" class="change-wrap" data-act="wrap" aria-label="Soft wrap" title="Soft wrap">${icon("text-wrap", 15)}</button></summary>
          <pre class="diff">Loading...</pre>
        </details>`).join("") || '<p class="provider-meta">No file changes.</p>'}
      <div class="change-actions">
        ${undoable ? `<button class="btn-secondary icon-btn-text" data-act="undo">${icon("undo-2", 14)}<span class="btn-label">Undo this</span></button>` : ""}
        <button class="btn-secondary icon-btn-text" data-act="restore">${icon("history", 14)}<span class="btn-label">Restore to here</span></button>
      </div>`;
    syncWrapButtons();
  } catch (e) {
    body.innerHTML = `<p>${escapeHtml(e.message)}</p>`;
  }
}

changesList.addEventListener("toggle", async (e) => {
  const details = e.target;
  if (!details.matches?.("details.change-file") || !details.open) return;
  const pre = details.querySelector(".diff");
  if (pre.dataset.loaded) return;
  const oid = details.closest(".change-item").dataset.oid;
  const path = details.dataset.path;
  try {
    const data = await changesApi(`/api/changes/${oid}/diff?path=${encodeURIComponent(path)}`);
    renderDiff(pre, data);
    pre.dataset.loaded = "1";
    // The +/- counts are only known once the diff has been fetched, so they land in the summary
    // afterwards rather than being listed for every file up front.
    const slot = details.querySelector(".change-file-stat");
    if (slot) slot.innerHTML = statsLabel(data);
  } catch (err) {
    pre.textContent = err.message;
  }
}, true);

// Soft wrap, from any open diff: the preference is shared with the Files viewer (CodeView), so it
// flips every code surface on screen at once. The button sits in the summary, so the tap must not
// also fold the file away.
changesList.addEventListener("click", (e) => {
  const btn = e.target.closest('button[data-act="wrap"]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  window.CodeView.toggleWrap();
  syncWrapButtons();
});

function syncWrapButtons() {
  changesList.querySelectorAll('button[data-act="wrap"]').forEach((b) => window.CodeView.syncWrapButton(b));
}

// Tapping a fold placeholder splices the hidden rows back in, in place. The first load sends a fold
// as a position (start, count) rather than the lines it hides, so they are fetched on the tap.
changesList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.code-fold");
  if (!btn || btn.disabled) return;
  const pre = btn.closest("pre.diff");
  if (!pre || !pre._rows) return;
  const at = Number(btn.dataset.index);
  const fold = pre._rows[at];
  if (!fold || fold.kind !== "meta") return;
  let hidden = fold.folded;
  if (!hidden && Number.isInteger(fold.start) && fold.count > 0) {
    const details = btn.closest("details.change-file");
    const oid = btn.closest(".change-item")?.dataset.oid;
    if (!details || !oid) return;
    btn.disabled = true;
    const label = btn.querySelector(".code-lc");
    const was = label.textContent;
    label.textContent = "Loading…";
    try {
      const q = new URLSearchParams({ path: details.dataset.path, from: String(fold.start), count: String(fold.count) });
      hidden = (await changesApi(`/api/changes/${oid}/diff?${q}`)).rows;
    } catch {
      hidden = null;
    }
    // A repaint while this was in flight (the same file reloaded) has its own rows; leave it be.
    if (pre._rows[at] !== fold) return;
    if (!Array.isArray(hidden) || !hidden.length) {
      btn.disabled = false;
      label.textContent = was;
      return;
    }
  }
  if (!hidden) return;
  pre._rows.splice(at, 1, ...hidden);
  paintDiff(pre);
});

function report(result, verb) {
  if (result.conflicts?.length) {
    alert(`${verb}, but these files were changed again by later work and were left alone:\n\n${result.conflicts.join("\n")}`);
  } else if (!result.reverted?.length) {
    alert("Nothing to change.");
  }
}

changesList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const oid = btn.closest(".change-item").dataset.oid;
  try {
    if (btn.dataset.act === "toggle") {
      open.has(oid) ? open.delete(oid) : open.add(oid);
      renderChanges();
    } else if (btn.dataset.act === "undo") {
      report(await changesApi(`/api/changes/${oid}/undo`, "POST"), "Undone");
      loadChanges();
    } else if (btn.dataset.act === "restore") {
      if (confirm("Restore every file to how it was after this change?")) {
        report(await changesApi(`/api/changes/${oid}/restore`, "POST"), "Restored");
        loadChanges();
      }
    }
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("refresh-changes-btn").addEventListener("click", loadChanges);
document.getElementById("undo-latest-btn").addEventListener("click", async () => {
  try {
    report(await changesApi("/api/changes/undo-latest", "POST"), "Reverted");
    loadChanges();
  } catch (err) {
    alert(err.message);
  }
});

// The server announces new checkpoints (the agent's checkpoint, undo from the native menu, ...).
window.onChangesEvent = () => {
  if (document.getElementById("tab-changes").classList.contains("active")) loadChanges();
};
