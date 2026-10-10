// Updates tab: shows the agent bundle the app is running, the bundles installed beside it, and the controls for
// checking, pinning and importing them. The app's host does the work (download, verify, install, pin); this is a
// view over its /api/bundles routes, which answer 503 when the page is not inside the app.

// Classic scripts share one global scope, so everything here lives in this function; only loadUpdates is exported.
(() => {
const updatesBody = document.getElementById("updates-body");
const updatesCheckBtn = document.getElementById("updates-check-btn");
const updatesImportBtn = document.getElementById("updates-import-btn");
const updatesImportInput = document.getElementById("updates-import-input");

/** While a check runs on the host, the status is re-read this often, for at most this long. */
const UPDATES_POLL_MS = 2000;
const UPDATES_POLL_MAX_MS = 60_000;

const SOURCE_LABEL = { embedded: "built into the app", ota: "downloaded update", import: "imported" };

let updatesStatus = null;
let updatesUnavailable = false;
let updatesNotice = null; // { kind: "ok" | "error", text } from the last action
let updatesPollTimer = null;
let updatesPollStarted = 0;

/** Attribute values are quoted, so quotes are escaped too. */
function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/** "3 min ago", "2 h ago", "5 days ago"; `ms` is an epoch timestamp. */
function checkedAgo(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function badge(text, cls = "") {
  return `<span class="badge${cls ? " " + cls : ""}">${escapeHtml(text)}</span>`;
}

function renderNotice() {
  if (!updatesNotice) return "";
  return `<div class="updates-notice ${updatesNotice.kind === "error" ? "is-error" : ""}" role="status">${escapeHtml(updatesNotice.text)}</div>`;
}

function renderUnavailable() {
  return `
    <div class="skills-empty">
      ${iconTag("circle-alert", 20, "dim")}
      <strong>Updates are managed by the app</strong>
      <p class="description">Open this page inside the Pidroid app to see the agent's version and check for updates. Nothing here works in a regular browser.</p>
    </div>`;
}

function renderCurrent(s) {
  const active = s.active || {};
  const badges = [
    active.verified ? badge("Verified", "ok") : badge("Unverified", "warn"),
    s.pinned != null ? badge("Pinned") : "",
  ].join("");
  return `
    <div class="provider-item updates-current">
      <div class="provider-info">
        <strong>Version ${escapeHtml(active.version ?? "unknown")}</strong>
        <span class="provider-meta">Build ${escapeHtml(active.code ?? "?")} · ${escapeHtml(SOURCE_LABEL[active.source] || active.source || "unknown source")}</span>
      </div>
      <div class="updates-badges">${badges}</div>
    </div>`;
}

function renderBanners(s) {
  const parts = [];
  if (s.appUpdate) {
    const apk = typeof s.appUpdate.apkUrl === "string" && /^https:\/\//.test(s.appUpdate.apkUrl) ? s.appUpdate.apkUrl : "";
    parts.push(`
      <div class="update-panel">
        <h3>App update required for ${escapeHtml(s.appUpdate.version)}</h3>
        <p>The newest agent needs a newer version of the Pidroid app. Until you install it, the agent stays on the version it is running.</p>
        ${apk ? `<p><a href="${escapeAttr(apk)}" target="_blank" rel="noopener">Download the Pidroid app update</a></p>` : ""}
      </div>`);
  }
  if (s.pinned != null) {
    parts.push(`
      <div class="updates-pinned">
        <div>
          <strong>Automatic updates paused (pinned)</strong>
          <span class="provider-meta">The agent stays on build ${escapeHtml(s.pinned)} until you return to the latest.</span>
        </div>
        <button type="button" class="btn-secondary icon-btn-text" data-act="unpin">${iconTag("rotate-ccw", 14)}<span class="btn-label">Return to latest</span></button>
      </div>`);
  }
  if (s.pending) {
    parts.push(`<p class="description updates-pending">Update ${escapeHtml(s.pending.version)} will apply when the agent is idle.</p>`);
  }
  return parts.join("");
}

function renderBundleRow(b) {
  const badges = [
    b.active ? badge("Active", "ok") : "",
    b.pinned ? badge("Pinned") : "",
    b.blocked ? badge("Blocked", "warn") : "",
    b.verified ? "" : badge("Unverified", "warn"),
  ].join("");
  const useButton = !b.active && !b.blocked
    ? `<button type="button" class="btn-secondary icon-btn-text" data-act="activate" data-code="${escapeAttr(b.code)}" data-version="${escapeAttr(b.version)}"><span class="btn-label">Use this version</span></button>`
    : "";
  return `
    <div class="file-item updates-row">
      <div class="provider-info">
        <strong>Version ${escapeHtml(b.version)}</strong>
        <span class="provider-meta">Build ${escapeHtml(b.code)} · ${escapeHtml(SOURCE_LABEL[b.source] || b.source || "unknown source")}</span>
      </div>
      <div class="updates-badges">${badges}</div>
      ${useButton}
    </div>`;
}

function render() {
  if (!updatesBody) return;
  if (updatesUnavailable) {
    updatesBody.innerHTML = renderNotice() + renderUnavailable();
    if (updatesCheckBtn) updatesCheckBtn.disabled = true;
    if (updatesImportBtn) updatesImportBtn.disabled = true;
    return;
  }
  if (!updatesStatus) {
    updatesBody.innerHTML = renderNotice() || '<p class="description">Loading updates...</p>';
    return;
  }

  const s = updatesStatus;
  const bundles = Array.isArray(s.bundles) ? [...s.bundles].sort((a, b) => b.code - a.code) : [];
  const checking = Boolean(s.checking);
  if (updatesCheckBtn) {
    updatesCheckBtn.disabled = checking;
    setLabel(updatesCheckBtn, checking ? "Checking..." : "Check now");
  }
  if (updatesImportBtn) updatesImportBtn.disabled = false;

  updatesBody.innerHTML = `
    ${renderNotice()}
    ${renderBanners(s)}

    <div class="editor-header"><h2>Running</h2></div>
    ${renderCurrent(s)}

    <div class="editor-header"><h2>Automatic updates</h2></div>
    <div class="theme-row">
      <label class="theme-label" for="updates-prerelease">Prerelease builds</label>
      <div class="theme-value">
        <label class="ext-switch" title="Also offer builds from the dev branch">
          <input type="checkbox" id="updates-prerelease" data-act="prerelease" ${s.prerelease ? "checked" : ""} />
          <span class="ext-switch-track"><span class="ext-switch-thumb"></span></span>
        </label>
      </div>
    </div>
    <p class="description">Off, the agent follows stable releases only. Prerelease builds come from the dev branch and may be less tested.</p>
    <div class="updates-check">
      <span class="provider-meta">${checking ? "Checking for updates…" : `Last checked ${escapeHtml(checkedAgo(s.lastCheck))}`}</span>
      ${s.lastError ? `<span class="updates-error">Last check failed: ${escapeHtml(s.lastError)}</span>` : ""}
    </div>

    <div class="editor-header"><h2>Installed bundles</h2></div>
    <p class="description">Each bundle is a complete copy of the agent's code. The one marked Active is running. Choosing another restarts the agent once it is idle.</p>
    ${bundles.length ? bundles.map(renderBundleRow).join("") : '<p class="description">No bundles installed yet.</p>'}
  `;
}

/** Fetches the status. Returns false when the page is not inside the app. */
async function refreshUpdates() {
  try {
    const res = await fetch("/api/bundles");
    if (res.status === 503) {
      updatesUnavailable = true;
      return false;
    }
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    updatesUnavailable = false;
    updatesStatus = data;
    return true;
  } catch (e) {
    updatesNotice = { kind: "error", text: `Could not read updates: ${e instanceof Error ? e.message : e}` };
    return false;
  }
}

/** While the host is checking, keep re-reading the status (it fills in lastCheck and any appUpdate). */
function pollUntilChecked() {
  clearTimeout(updatesPollTimer);
  updatesPollTimer = null;
  if (Date.now() - updatesPollStarted > UPDATES_POLL_MAX_MS) return;
  updatesPollTimer = setTimeout(async () => {
    updatesPollTimer = null;
    await refreshUpdates();
    render();
    if (updatesStatus?.checking) pollUntilChecked();
  }, UPDATES_POLL_MS);
}

async function loadUpdates() {
  if (!updatesBody) return;
  await refreshUpdates();
  render();
  if (updatesStatus?.checking && !updatesPollTimer) {
    updatesPollStarted = Date.now();
    pollUntilChecked();
  }
}

/** POSTs to a /api/bundles route and re-renders from its answer. Returns the response body, or null on failure. */
async function bundlePost(path, body, okText) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);
    updatesStatus = data;
    updatesUnavailable = false;
    updatesNotice = okText ? { kind: "ok", text: okText } : null;
    render();
    return data;
  } catch (e) {
    updatesNotice = { kind: "error", text: e instanceof Error ? e.message : String(e) };
    await refreshUpdates();
    render();
    return null;
  }
}

async function checkNow() {
  updatesNotice = null;
  const data = await bundlePost("/api/bundles/check");
  if (data?.checking) {
    updatesPollStarted = Date.now();
    pollUntilChecked();
  }
}

/** Uploads a zip. An unverified one needs the user's say-so, asked once and then sent with allowUnverified. */
async function importBundleFile(file, allowUnverified = false) {
  updatesNotice = { kind: "ok", text: `Installing ${file.name}…` };
  render();
  try {
    const res = await fetch(`/api/bundles/import${allowUnverified ? "?allowUnverified=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      if (data.code === "unverified" && !allowUnverified) {
        const ok = confirm(
          "This bundle is not signed by the Pidroid release key, so it did not come from the Pidroid project.\n\n" +
          "Only continue if you built it yourself. Install it anyway?",
        );
        if (ok) return importBundleFile(file, true);
        updatesNotice = { kind: "error", text: "Import cancelled. The bundle was not installed." };
      } else {
        updatesNotice = { kind: "error", text: `Import failed: ${data.error || res.statusText}` };
      }
    } else {
      updatesNotice = {
        kind: "ok",
        text: `Installed version ${data.version ?? ""} (build ${data.code ?? "?"}). It is pinned and starts when the agent is idle.`,
      };
    }
  } catch (e) {
    updatesNotice = { kind: "error", text: `Import failed: ${e instanceof Error ? e.message : e}` };
  }
  await refreshUpdates();
  render();
}

updatesCheckBtn?.addEventListener("click", checkNow);

updatesImportBtn?.addEventListener("click", () => updatesImportInput?.click());

updatesImportInput?.addEventListener("change", () => {
  const file = updatesImportInput.files?.[0];
  updatesImportInput.value = ""; // so picking the same file again still fires change
  if (file) importBundleFile(file);
});

updatesBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "unpin") {
    updatesNotice = null;
    bundlePost("/api/bundles/unpin", {}, "Back on the latest version. Checking for updates…").then((data) => {
      if (data?.checking) {
        updatesPollStarted = Date.now();
        pollUntilChecked();
      }
    });
  } else if (act === "activate") {
    const version = button.dataset.version;
    const code = Number(button.dataset.code);
    if (!confirm(`Use version ${version}? The agent restarts with it once it is idle, and automatic updates stay paused until you return to the latest.`)) return;
    bundlePost("/api/bundles/activate", { code }, `Version ${version} will start when the agent is idle.`);
  }
});

updatesBody?.addEventListener("change", (event) => {
  const input = event.target.closest('[data-act="prerelease"]');
  if (!input) return;
  const enabled = input.checked;
  input.disabled = true;
  bundlePost("/api/bundles/prerelease", { enabled }, enabled ? "Prerelease builds are now offered." : "Stable releases only.").then((data) => {
    if (!data) input.checked = !enabled;
    input.disabled = false;
  });
});

window.loadUpdates = loadUpdates;
})();
