// Extensions tab: lists the built-in and user extensions, toggles each one and triggers the hot-swap reload via /api/reload.
// The server's ExtensionLoader does the work; this is just a view over it. A toggle is applied by
// POSTing it and reloading in the same step, so what the list shows is what is actually installed.

const extList = document.getElementById("extensions-list");
const extResult = document.getElementById("extensions-result");
const reloadExtBtn = document.getElementById("reload-ext-btn");

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Built-in extensions ship with the app; user ones are the agent's own, in the data directory. */
const ORIGIN_LABEL = { builtin: "built-in", user: "yours" };

function row({ key, origin, file, name, enabled, switchable }) {
  const toggle = switchable
    ? `<label class="ext-switch" title="${enabled ? "On" : "Off"}">
         <input type="checkbox" data-ext-toggle="${escapeHtml(key)}" ${enabled ? "checked" : ""}
                aria-label="Enable ${escapeHtml(name)}" />
         <span class="ext-switch-track"><span class="ext-switch-thumb"></span></span>
       </label>`
    : `<span class="change-kind parked">parked</span>`;
  // The extension's own name is the label; the file it lives in is just an implementation detail, so it
  // only appears where there is no name to show (a parked file was never imported to find one).
  const label = switchable ? name : file;
  const note = switchable
    ? `<span class="ext-note">${escapeHtml(ORIGIN_LABEL[origin] || origin)}</span>`
    : `<span class="ext-note">${escapeHtml(ORIGIN_LABEL[origin] || origin)} · prefixed with _, skipped by the loader</span>`;
  // Label on the left, switch hard right; the note (origin, and why a parked file has no switch) sits between them.
  return `
    <div class="file-item ext-item${enabled === false ? " is-off" : ""}">
      <span class="file-name">${iconTag("file-text", 16, "dim")} <strong>${escapeHtml(label)}</strong></span>
      ${note}
      ${toggle}
    </div>`;
}

async function loadExtensions() {
  if (!extList) return;
  try {
    const state = await fetch("/api/extensions").then((r) => r.json());
    if (state.error) throw new Error(state.error);

    const rows = [
      ...(state.extensions || []).map((e) => row({ ...e, switchable: true })),
      ...(state.parked || []).map((p) => row({ key: `${p.origin}:${p.file}`, origin: p.origin, file: p.file, name: p.file, enabled: false, switchable: false })),
    ];

    extList.innerHTML = rows.length
      ? rows.join("")
      : '<p class="description">No extension files yet. Ask the agent to write one into <code>$PIDROID_DATA_DIR/extensions</code>, then press Reload.</p>';
  } catch (e) {
    extList.innerHTML = `<p class="description">Error loading extensions: ${escapeHtml(e)}</p>`;
  }
}

function renderReloadResult(result) {
  if (!extResult) return;
  const lines = [];
  for (const l of result.loaded || []) lines.push(`loaded  ${l}`);
  for (const s of result.skipped || []) lines.push(`off     ${s}`);
  for (const r of result.removed || []) lines.push(`removed ${r}`);
  for (const [key, error] of Object.entries(result.errors || {})) lines.push(`ERROR   ${key}: ${error}`);
  extResult.textContent = lines.length ? lines.join("\n") : "Nothing to do: no extension files found.";
}

function markPopulated() {
  if (extResult) extResult.dataset.populated = "1";
}

async function reloadExtensions() {
  if (!reloadExtBtn || !extResult) return;
  reloadExtBtn.disabled = true;
  extResult.textContent = "Reloading...";
  try {
    const res = await fetch("/api/reload", { method: "POST" });
    const data = await res.json();
    if (data.error) {
      extResult.textContent = "Reload failed: " + data.error;
    } else {
      renderReloadResult(data);
      markPopulated();
    }
  } catch (e) {
    extResult.textContent = "Reload failed: " + e;
  } finally {
    reloadExtBtn.disabled = false;
    loadExtensions();
  }
}

// Flipping a switch stores the choice and hot-swaps in one call, so the extension is out of the
// registry (tools gone, prompt sections and hooks dropped) before the next turn starts.
async function toggleExtension(key, enabled, input) {
  input.disabled = true;
  try {
    const res = await fetch("/api/extensions/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, enabled }),
    });
    const data = await res.json();
    if (data.error) {
      input.checked = !enabled;
      extResult.textContent = `Could not toggle ${key}: ${data.error}`;
      return;
    }
    renderReloadResult(data.reload || {});
    markPopulated();
  } catch (e) {
    input.checked = !enabled;
    extResult.textContent = `Could not toggle ${key}: ${e}`;
  } finally {
    input.disabled = false;
    input.closest(".ext-item")?.classList.toggle("is-off", !enabled);
  }
}

extList?.addEventListener("change", (event) => {
  const input = event.target.closest("[data-ext-toggle]");
  if (!input) return;
  toggleExtension(input.dataset.extToggle, input.checked, input);
});

document.getElementById("reload-ext-btn")?.addEventListener("click", reloadExtensions);

window.loadExtensionsTab = () => {
  loadExtensions();
  // Show the last known state if we have it, otherwise prompt to reload.
  if (extResult && extResult.dataset.populated !== "1") {
    extResult.textContent = "No reload yet this session. Press Reload to hot-swap the extensions.";
  }
};

// Auto-populate the result panel after the first reload.
window.onExtensionsResult = (result) => {
  renderReloadResult(result);
  markPopulated();
};

loadExtensions();
