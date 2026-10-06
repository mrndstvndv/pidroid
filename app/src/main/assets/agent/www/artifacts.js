// Artifacts: the files in the current session's workspace, with viewers.
//
// The server lists the workspace (/api/workspace/tree) and serves each file raw under
// /workspace/<session>/<path> with a sandboxing CSP. That path-style URL is what lets an HTML
// artifact's relative CSS, scripts and images load inside the preview iframe. The iframe is also
// sandboxed without allow-same-origin, so a previewed page can run but cannot touch the app.
// IIFE for the same reason as files-tab.js: classic scripts share one global scope.

(function () {

const list = document.getElementById("artifacts-list");
const viewer = document.getElementById("artifacts-viewer");
const title = document.getElementById("artifacts-title");
const backBtn = document.getElementById("artifacts-back");
const refreshBtn = document.getElementById("artifacts-refresh");
const sourceBtn = document.getElementById("artifacts-source-btn");

const TEXT_MAX = 512 * 1024;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const HTML_EXT = new Set(["html", "htm"]);
const BINARY_EXT = new Set(["zip", "gz", "tar", "sqlite", "db", "so", "apk", "jar", "pdf", "mp3", "mp4", "wav", "ogg", "webm", "woff", "woff2", "ttf", "otf", "bin"]);

let data = null;
const openDirs = new Set();
let openFile = null; // { node, mode: "preview" | "source" }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ext = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const fileUrl = (node) => `/workspace/${data.session}/${node.path.split("/").map(encodeURIComponent).join("/")}`;

function formatBytes(n) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(node) {
  if (node.dir) return "folder";
  const e = ext(node.name);
  if (HTML_EXT.has(e)) return "code";
  return ["md", "txt", "json", "csv", "log"].includes(e) ? "file-text" : "file";
}

/* ---------- tree ---------- */

function rows(nodes, depth, out) {
  for (const node of nodes) {
    const open = node.dir && openDirs.has(node.path);
    out.push(
      `<button type="button" class="artifact-row${node.dir ? " is-dir" : ""}" data-path="${esc(node.path)}" style="padding-left:${12 + depth * 16}px">` +
        `<span class="artifact-chev">${node.dir ? icon(open ? "chevron-down" : "chevron-right", 14) : ""}</span>` +
        `<span class="artifact-ico">${icon(iconFor(node), 16)}</span>` +
        `<span class="artifact-name">${esc(node.name)}</span>` +
        `<span class="artifact-size">${node.dir ? "" : formatBytes(node.size)}</span>` +
      `</button>`
    );
    if (open && node.children) rows(node.children, depth + 1, out);
  }
}

function findNode(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.dir && node.children) {
      const hit = findNode(node.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

function renderList() {
  if (!data) return;
  title.textContent = openFile ? openFile.node.name : "Artifacts";
  if (!data.tree.length) {
    list.innerHTML = `<p class="description artifacts-empty">This session's workspace is empty. Files the agent creates will show up here.</p>`;
    return;
  }
  const out = [`<p class="artifacts-session">${esc(data.title || "Session")} &middot; workspace</p>`];
  rows(data.tree, 0, out);
  if (data.truncated) out.push(`<p class="description">Listing truncated.</p>`);
  list.innerHTML = out.join("");
}

list.addEventListener("click", (e) => {
  const row = e.target.closest(".artifact-row");
  if (!row || !data) return;
  const node = findNode(data.tree, row.dataset.path);
  if (!node) return;
  if (node.dir) {
    if (openDirs.has(node.path)) openDirs.delete(node.path);
    else openDirs.add(node.path);
    renderList();
  } else {
    showFile(node);
  }
});

/* ---------- viewers ---------- */

async function showFile(node, mode) {
  const e = ext(node.name);
  const isHtml = HTML_EXT.has(e);
  openFile = { node, mode: mode || (isHtml ? "preview" : "source") };
  list.hidden = true;
  viewer.hidden = false;
  sourceBtn.hidden = !isHtml;
  title.textContent = node.name;

  const url = fileUrl(node);

  if (isHtml && openFile.mode === "preview") {
    // allow-same-origin is deliberately absent: the page gets an opaque origin.
    viewer.innerHTML = `<iframe class="artifact-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="${esc(url)}"></iframe>`;
    return;
  }
  if (IMAGE_EXT.has(e)) {
    viewer.innerHTML = `<div class="artifact-image"><img src="${esc(url)}" alt="${esc(node.name)}" /></div>`;
    return;
  }
  if (BINARY_EXT.has(e) || node.size > TEXT_MAX) {
    viewer.innerHTML = `<p class="description artifacts-empty">${esc(node.name)} (${formatBytes(node.size)}) has no inline preview.</p>`;
    return;
  }
  viewer.innerHTML = `<p class="description artifacts-empty">Loading...</p>`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    const text = await res.text();
    if (openFile?.node !== node) return; // navigated away while loading
    if (text.slice(0, 4096).includes("\u0000")) {
      viewer.innerHTML = `<p class="description artifacts-empty">Binary file, no preview.</p>`;
      return;
    }
    viewer.innerHTML = `<pre class="artifact-source"></pre>`;
    viewer.firstChild.textContent = text;
  } catch (err) {
    viewer.innerHTML = `<p class="description artifacts-empty">Could not open file: ${esc(err.message || err)}</p>`;
  }
}

function closeFile() {
  openFile = null;
  viewer.hidden = true;
  viewer.innerHTML = ""; // also stops any running page in the preview iframe
  list.hidden = false;
  sourceBtn.hidden = true;
  renderList();
}

sourceBtn.addEventListener("click", () => {
  if (!openFile) return;
  showFile(openFile.node, openFile.mode === "preview" ? "source" : "preview");
});

backBtn.addEventListener("click", () => {
  if (openFile) closeFile();
  else window.showScreen?.("chat");
});

refreshBtn.addEventListener("click", () => {
  if (openFile) showFile(openFile.node, openFile.mode);
  else loadArtifacts();
});

/* ---------- loading ---------- */

async function loadArtifacts() {
  if (openFile) closeFile();
  list.hidden = false;
  try {
    const res = await fetch("/api/workspace/tree");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    if (data && data.session !== json.session) openDirs.clear();
    data = json;
    renderList();
  } catch (err) {
    list.innerHTML = `<p class="description artifacts-empty">Could not load the workspace: ${esc(err.message || err)}</p>`;
  }
}

window.loadArtifacts = loadArtifacts;
// app.js's Android back-button handler: close an open file first, the screen only when none is open.
window.artifactsHandleBack = () => {
  if (!openFile) return false;
  closeFile();
  return true;
};

})();
