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

const KIND_LABEL = { init: "shipped", external: "external", edits: "manual", turn: "agent", undo: "undo" };

async function loadChanges() {
  try {
    entries = (await changesApi("/api/changes")).entries;
    renderChanges();
  } catch (e) {
    changesList.innerHTML = `<p>Error loading changes: ${escapeHtml(e.message)}</p>`;
  }
}
window.loadChanges = loadChanges;

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
          <summary><span class="st-${f.status}">${f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~"}</span> ${escapeHtml(f.path)}</summary>
          <pre class="diff">Loading...</pre>
        </details>`).join("") || '<p class="provider-meta">No file changes.</p>'}
      <div class="change-actions">
        ${undoable ? `<button class="btn-secondary icon-btn-text" data-act="undo">${icon("undo-2", 14)}<span class="btn-label">Undo this</span></button>` : ""}
        <button class="btn-secondary icon-btn-text" data-act="restore">${icon("history", 14)}<span class="btn-label">Restore to here</span></button>
      </div>`;
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
  try {
    const { diff } = await changesApi(`/api/changes/${oid}/diff?path=${encodeURIComponent(details.dataset.path)}`);
    pre.innerHTML = colorDiff(diff);
    pre.dataset.loaded = "1";
  } catch (err) {
    pre.textContent = err.message;
  }
}, true);

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

// The server announces new checkpoints (turn finished, undo from the native menu, ...).
window.onChangesEvent = () => {
  if (document.getElementById("tab-changes").classList.contains("active")) loadChanges();
};
