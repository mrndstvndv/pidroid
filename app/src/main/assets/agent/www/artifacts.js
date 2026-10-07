// Files: the current session's workspace, with viewers. What the agent showed in chat (its
// artifacts, see the show tool) is listed first, so a card scrolled far up is one tap away.
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
const MD_EXT = new Set(["md", "markdown", "mdown", "mkd"]);
const BINARY_EXT = new Set(["zip", "gz", "tar", "sqlite", "db", "so", "apk", "jar", "pdf", "mp3", "mp4", "wav", "ogg", "webm", "woff", "woff2", "ttf", "otf", "bin"]);

let data = null;
const openDirs = new Set();
let errors = []; // errors reported by the previewed page (see the hook the server injects into HTML)
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
  return ["md", "markdown", "txt", "json", "csv", "log"].includes(e) ? "file-text" : "file";
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

function shownRows(out) {
  const shown = (window.chatShownArtifacts?.() || []).filter((a) => findNode(data.tree, a.path));
  if (!shown.length) return;
  out.push(`<p class="artifacts-session">Shown in chat</p>`);
  for (const a of shown) {
    out.push(
      `<button type="button" class="artifact-row" data-path="${esc(a.path)}" style="padding-left:12px">` +
        `<span class="artifact-chev"></span>` +
        `<span class="artifact-ico">${icon("sparkles", 16)}</span>` +
        `<span class="artifact-name">${esc(a.title)}</span>` +
        `<span class="artifact-size">${esc(a.path)}</span>` +
      `</button>`
    );
  }
}

function renderList() {
  if (!data) return;
  title.textContent = openFile ? openFile.node.name : "Files";
  if (!data.tree.length) {
    list.innerHTML = `<p class="description artifacts-empty">This session's workspace is empty. Files the agent creates will show up here.</p>`;
    return;
  }
  const out = [];
  shownRows(out);
  out.push(`<p class="artifacts-session">${esc(data.title || "Session")} &middot; workspace</p>`);
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

/* ---------- markdown ----------

   A .md file is rendered by the server (the same renderer the chat messages use) and shown in a
   sandboxed iframe built from srcdoc: the HTML comes from a workspace file, and Bun's renderer
   passes raw HTML in the source straight through, so it must not land in the app's own document.
   The iframe gets no allow-same-origin either, so a file that manages to run script there is still
   stuck in an opaque origin. Its stylesheet is inlined rather than linked so the page cannot pull
   in anything else, and the theme's colours are read off the app and handed over as variables. */

const THEME_VARS = [
  "--bg-primary", "--bg-secondary", "--bg-card", "--bg-inset", "--accent",
  "--text-primary", "--text-secondary", "--border",
];

/** The workspace directory a file lives in, as a URL prefix relative images and links resolve against. */
function workspaceBase(node) {
  const dir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/") + 1) : "";
  const parts = dir.split("/").filter(Boolean).map(encodeURIComponent);
  return `/workspace/${data.session}/${parts.join("/")}`;
}

function markdownDocument(html, node) {
  const appStyle = getComputedStyle(document.documentElement);
  // --bg-inset is a color-mix() of two other variables, which comes back from the cascade as the
  // expression rather than a colour; a probe element resolves it to the rgb() the app is painting.
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.backgroundColor = "var(--bg-inset)";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const vars = THEME_VARS.map((name) => {
    const value = name === "--bg-inset" ? resolved : appStyle.getPropertyValue(name).trim();
    return `${name}:${value && value !== "rgba(0, 0, 0, 0)" ? value : "#000"}`;
  }).join(";");
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<base href="${esc(workspaceBase(node))}">` +
    `<style>:root{${vars}}
body{margin:0;background:var(--bg-primary);color:var(--text-primary);
  font:15px/1.55 -apple-system,Roboto,"Segoe UI",sans-serif;overflow-wrap:break-word;}
article{padding:14px 16px max(24px,env(safe-area-inset-bottom,0px));}
h1,h2,h3,h4,h5,h6{margin:14px 0 6px;line-height:1.3;font-weight:700;}
h1{font-size:1.3rem;}h2{font-size:1.15rem;}h3{font-size:1.05rem;}h4,h5,h6{font-size:0.95rem;color:var(--text-secondary);}
article>:first-child{margin-top:0;}article>:last-child{margin-bottom:0;}
p{margin:8px 0;}
a{color:var(--accent);text-decoration:none;}a:active{text-decoration:underline;}
ul,ol{margin:6px 0;padding-left:22px;}li{margin:3px 0;}li>ul,li>ol{margin:2px 0;}
.task-list-item{list-style:none;margin-left:-20px;}
blockquote{margin:8px 0;padding:2px 0 2px 10px;border-left:2px solid var(--border);color:var(--text-secondary);}
hr{border:none;border-top:1px solid var(--border);margin:12px 0;}
code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.8rem;}
code{background:var(--bg-inset);border-radius:4px;padding:1px 4px;}
pre{background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0;
  overflow-x:auto;white-space:pre-wrap;word-break:break-word;}
pre code{background:none;padding:0;border-radius:0;}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:0.82rem;display:block;overflow-x:auto;}
th,td{border:1px solid var(--border);padding:5px 8px;text-align:left;}
th{background:var(--bg-inset);font-weight:600;}
img{max-width:100%;border-radius:8px;}</style></head><body><article>${html}</article>` +
    // Links leave the sandbox with window.open, which needs allow-popups; in-page anchors still work.
    `<script>document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a");` +
    `if(!a)return;var h=a.getAttribute("href")||"";if(!h||h.charAt(0)==="#")return;` +
    `e.preventDefault();window.open(a.href,"_blank","noopener")})<\/script></body></html>`;
}

async function showMarkdown(node) {
  viewer.innerHTML = `<p class="description artifacts-empty">Loading...</p>`;
  try {
    const query = new URLSearchParams({ session: String(data.session), path: node.path });
    const res = await fetch(`/api/workspace/markdown?${query}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    if (openFile?.node !== node) return; // navigated away while rendering
    viewer.innerHTML = `<iframe class="artifact-frame artifact-md-frame" sandbox="allow-scripts allow-popups"></iframe>`;
    viewer.querySelector("iframe").srcdoc = markdownDocument(json.html, node);
  } catch (err) {
    viewer.innerHTML = `<p class="description artifacts-empty">Could not render ${esc(node.name)}: ${esc(err.message || err)}</p>`;
  }
}

async function showFile(node, mode) {
  const e = ext(node.name);
  const isHtml = HTML_EXT.has(e);
  const isMd = MD_EXT.has(e);
  const toggleable = isHtml || isMd; // both have a rendered view and a raw one
  openFile = { node, mode: mode || (toggleable ? "preview" : "source") };
  list.hidden = true;
  viewer.hidden = false;
  sourceBtn.hidden = !toggleable;
  title.textContent = node.name;

  const url = fileUrl(node);

  if (isHtml && openFile.mode === "preview") {
    // allow-same-origin is deliberately absent: the page gets an opaque origin.
    errors = [];
    viewer.innerHTML =
      `<iframe class="artifact-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="${esc(url)}"></iframe>` +
      `<div class="artifact-errors" hidden>` +
        `<div class="artifact-errors-bar"><span class="artifact-errors-title"></span>` +
          `<button type="button" data-act="copy">Copy</button><button type="button" data-act="clear">Dismiss</button></div>` +
        `<pre class="artifact-errors-text"></pre>` +
      `</div>`;
    return;
  }
  if (isMd && openFile.mode === "preview") {
    await showMarkdown(node);
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

/* ---------- preview errors ----------
   The server injects a script into served HTML that postMessages uncaught errors up to here. The panel is
   plain selectable text in a scroll container, so it can be read in full and copied, unlike an error the
   page paints on its own canvas. */

function renderErrors() {
  const panel = viewer.querySelector(".artifact-errors");
  if (!panel) return;
  panel.hidden = errors.length === 0;
  panel.querySelector(".artifact-errors-title").textContent = errors.length === 1 ? "Page error" : `${errors.length} page errors`;
  panel.querySelector(".artifact-errors-text").textContent = errors.join("\n\n");
}

window.addEventListener("message", (e) => {
  const frame = viewer.querySelector("iframe");
  if (!frame || e.source !== frame.contentWindow) return;
  const msg = e.data && e.data.pidroidArtifactError;
  if (typeof msg !== "string") return;
  if (errors.length < 20 && errors[errors.length - 1] !== msg) errors.push(msg);
  renderErrors();
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { /* nothing more to try */ }
    ta.remove();
    return ok;
  }
}

viewer.addEventListener("click", async (e) => {
  const btn = e.target.closest(".artifact-errors button");
  if (!btn) return;
  if (btn.dataset.act === "clear") {
    errors = [];
    renderErrors();
  } else {
    const ok = await copyText(errors.join("\n\n"));
    btn.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  }
});

/* ---------- loading ---------- */

let loading = null;
let pendingOpen = null; // a path to open once the listing arrives (an artifact card's open button)

function loadArtifacts() {
  if (openFile) closeFile();
  list.hidden = false;
  loading = (async () => {
    try {
      const res = await fetch("/api/workspace/tree");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      if (data && data.session !== json.session) openDirs.clear();
      data = json;
      renderList();
      const node = pendingOpen && findNode(data.tree, pendingOpen);
      pendingOpen = null;
      if (node && !node.dir) showFile(node);
    } catch (err) {
      list.innerHTML = `<p class="description artifacts-empty">Could not load the workspace: ${esc(err.message || err)}</p>`;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Opens one workspace file in the viewer. The screen is shown first (which starts a listing),
 *  so this rides on that load rather than starting a second one. */
function openArtifactFile(path) {
  pendingOpen = String(path || "").replace(/^\.\//, "");
  if (!loading) loadArtifacts();
}

window.loadArtifacts = loadArtifacts;
window.openArtifactFile = openArtifactFile;
// Back closes an open file first; the screen itself is closed by app.js's own layer below it.
registerBackLayer(60, () => openFile !== null, closeFile);

})();
