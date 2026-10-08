// Files tab: a tree of the whole harness, mirroring exactly what save_bundle archives.
//
// The server returns the tree in one request (/api/files/tree) with each file already labelled
// against the shipped baseline, so this file only renders and previews. Keeping the walk on the
// server is what makes the tab honest: the skip lists (vendor, .git, auth.json, the sqlite
// databases) live in one place, next to the archive code they mirror, instead of being a second
// list of paths to drift out of sync here.
//
// Everything below is wrapped in an IIFE on purpose. These are classic scripts sharing one global
// scope, so a top-level `function render()` here becomes window.render -- and chat.js declares a
// `render()` too. Whichever script loads last wins, and the loser's internal calls silently resolve
// to the winner: the tree would keep showing its placeholder while chat.js redrew the status bar.
// Same collision already bit escapeHtml between app.js and extensions-tab.js. Scoping the file keeps
// its helpers private; only loadFilesTree is deliberately published on window.

(function () {

const treeContainer = document.getElementById("files-tree");
const filesSummary = document.getElementById("files-summary");
const filesSearch = document.getElementById("files-search");
const filesCollapseBtn = document.getElementById("files-collapse-btn");
const filesExpandBtn = document.getElementById("files-expand-btn");

let fileTree = null;
/** Directories the user has opened, as a Set of paths. Survives a refresh so the tree does not
 *  collapse under them every time the agent writes a file. */
const openDirs = new Set();
let filterText = "";
let previewPath = null;

/* ---------- formatting ---------- */

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How a file differs from the app's shipped baseline. This is the same three-way labelling
 *  save_bundle writes into MANIFEST.json, so "modified" here means "in the tarball as modified". */
const STATUS = {
  "not-shipped": { label: "new", title: "Not in the shipped baseline: a file added since install, or an app asset" },
  modified: { label: "edited", title: "Differs from the shipped baseline: your work, or the agent's" },
  unchanged: { label: "", title: "Identical to the shipped baseline" },
};

function countDescendants(node) {
  if (node.dir && node.children) return node.children.reduce((sum, child) => sum + countDescendants(child), 0);
  return 1;
}

function countDescendantsBytes(node) {
  if (node.dir && node.children) return node.children.reduce((sum, child) => sum + countDescendantsBytes(child), 0);
  return node.size || 0;
}

/* ---------- filtering ----------
   A match keeps its parent chain visible, otherwise a hit deep in providers/ would have nothing
   to hang under. Folders that contain a hit but are not themselves a hit render in a muted
   "matching through me" state rather than pretending their own name matched. */
function matchesFilter(node) {
  if (!filterText) return true;
  if (node.name.toLowerCase().includes(filterText)) return true;
  if (node.dir && node.children) return node.children.some(matchesFilter);
  return false;
}

function selfMatches(node) {
  return !!filterText && node.name.toLowerCase().includes(filterText);
}

/* ---------- rendering ---------- */

function render() {
  if (!treeContainer || !fileTree) return;

  const visible = fileTree.filter(matchesFilter);
  if (!visible.length) {
    treeContainer.innerHTML = `<p class="files-empty">${filterText ? "No file matches that filter." : "No files."}</p>`;
    return;
  }

  const rows = [];
  const emit = (node, depth) => {
    // A filtered tree starts fully open: the whole point of a filter is to see every hit at once.
    const open = filterText ? true : openDirs.has(node.path);

    if (node.dir) {
      const files = countDescendants(node) - 1; // less the folder itself
      const size = countDescendantsBytes(node);
      const dim = filterText && !selfMatches(node);
      rows.push(`
        <div class="tree-row tree-dir${open ? " open" : ""}${dim ? " dim" : ""}" data-path="${escapeHtmlAttr(node.path)}" role="treeitem" aria-expanded="${open}" tabindex="0" style="--depth:${depth}">
          <span class="tree-twist">${iconTag(open ? "chevron-down" : "chevron-right", 15, "dim")}</span>
          <span class="tree-icon">${iconTag("folder", 15, "dim")}</span>
          <span class="tree-name">${escapeHtml(node.name)}</span>
          <span class="tree-meta">${files} file${files === 1 ? "" : "s"}${size ? ` · ${formatBytes(size)}` : ""}</span>
        </div>`);
      if (open && node.children) for (const child of node.children) if (matchesFilter(child)) emit(child, depth + 1);
      return;
    }

    const status = STATUS[node.status] || { label: "", title: "" };
    rows.push(`
      <div class="tree-row tree-file${previewPath === node.path ? " selected" : ""}" data-path="${escapeHtmlAttr(node.path)}" role="treeitem" tabindex="0" style="--depth:${depth}">
        <span class="tree-twist"></span>
        <span class="tree-icon">${iconTag(fileIcon(node.name), 15, "dim")}</span>
        <span class="tree-name">${escapeHtml(node.name)}</span>
        ${status.label ? `<span class="tree-badge ${node.status}" title="${escapeHtmlAttr(status.title)}">${status.label}</span>` : ""}
        <span class="tree-meta">${formatBytes(node.size)}</span>
      </div>`);
  };
  for (const node of visible) emit(node, 0);

  treeContainer.innerHTML = rows.join("");
  treeContainer.setAttribute("role", "tree");
}

/** Rough typing, same idea as the file icons elsewhere in the app. */
function fileIcon(name) {
  if (/\.(ts|js|json|html|css|mjs|cjs)$/.test(name)) return "code";
  if (/\.svg$/.test(name)) return "file";
  if (/\.md$|\.txt$/i.test(name)) return "file-text";
  return "file";
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/* ---------- summary ---------- */

function renderSummary(deleted) {
  if (!filesSummary) return;
  const parts = [`<strong>${counts.files}</strong> files · ${formatBytes(counts.totalBytes)}`];
  if (counts.modified) parts.push(`<span class="sum edited">${counts.modified} edited</span>`);
  if (counts.notShipped) parts.push(`<span class="sum new">${counts.notShipped} new</span>`);
  if (deleted?.length) parts.push(`<span class="sum deleted">${deleted.length} deleted from the app</span>`);
  filesSummary.innerHTML = parts.join(" · ");
}

/* ---------- data ---------- */

let counts = { files: 0, modified: 0, notShipped: 0, totalBytes: 0 };

async function loadFilesTree() {
  if (!treeContainer) return;
  treeContainer.innerHTML = "<p>Loading files...</p>";
  try {
    const data = await fetch("/api/files/tree").then((r) => r.json());
    if (data.error) throw new Error(data.error);
    fileTree = Array.isArray(data.tree) ? data.tree : [];
    counts = data.counts || counts;

    // Deleted entries are shown at the root as a struck-through ghost list: they are real news
    // (a shipped file is gone) but they have no content to open.
    const ghosts = (data.deleted || []).map(
      path => `<div class="tree-row tree-file is-deleted" role="treeitem" tabindex="-1" style="--depth:0">
        <span class="tree-twist"></span>
        <span class="tree-icon">${iconTag("circle-alert", 15, "dim")}</span>
        <span class="tree-name">${escapeHtml(path)}</span>
        <span class="tree-badge deleted" title="Was shipped with the app, now missing from disk">deleted</span>
      </div>`);

    render();
    if (ghosts.length && !filterText) {
      treeContainer.insertAdjacentHTML("beforeend", `<div class="tree-sep"><span>missing from disk</span></div>${ghosts.join("")}`);
    }
    renderSummary(data.deleted || []);
  } catch (e) {
    treeContainer.innerHTML = `<p class="files-empty">Could not load the file tree: ${escapeHtml(String(e.message || e))}</p>`;
  }
}

/* ---------- preview ---------- */

async function openPreview(path) {
  previewPath = path;
  render();
  const modal = document.getElementById("file-modal");
  const body = document.getElementById("file-modal-body");
  const title = document.getElementById("file-modal-title");
  if (!modal || !body) return;

  title.textContent = path;
  modal.hidden = false;

  // Shared code surface (code-view.js): loading state, syntax colouring when the server recognises
  // the language, plain escaped text when it does not, and a guard against a slow load landing
  // after the user has already opened a different file.
  const pre = document.createElement("pre");
  pre.className = "file-preview";
  body.replaceChildren(pre);
  await window.CodeView.load(pre, {
    // One endpoint answers both: the text, and its colours when the language is known. There is
    // no plain URL to fall back to, so a failed read is an error rather than a second fetch.
    highlightUrl: `/api/files/read?path=${encodeURIComponent(path)}`,
    stillCurrent: () => previewPath === path,
    errorLabel: "Could not read the file",
  });
}

function closePreview() {
  previewPath = null;
  const modal = document.getElementById("file-modal");
  if (modal) modal.hidden = true;
  render();
}

/* ---------- events ---------- */

treeContainer?.addEventListener("click", (event) => {
  const row = event.target.closest(".tree-row");
  if (!row) return;
  const path = row.dataset.path;
  if (!path) return;
  if (row.classList.contains("tree-dir")) {
    if (openDirs.has(path)) openDirs.delete(path);
    else openDirs.add(path);
    render();
  } else {
    openPreview(path);
  }
});

// Keyboard parity with the click handlers: tree rows are focusable, Enter/Space activates them and
// the twisters are real buttons, so a tree is usable without a touchscreen.
treeContainer?.addEventListener("keydown", (event) => {
  const row = event.target.closest(".tree-row");
  if (!row) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    row.click();
  }
});

filesSearch?.addEventListener("input", () => {
  filterText = filesSearch.value.trim().toLowerCase();
  render();
});

filesCollapseBtn?.addEventListener("click", () => {
  openDirs.clear();
  render();
});

filesExpandBtn?.addEventListener("click", () => {
  const openAll = (nodes) => {
    for (const node of nodes) {
      if (node.dir) {
        openDirs.add(node.path);
        if (node.children) openAll(node.children);
      }
    }
  };
  if (fileTree) openAll(fileTree);
  render();
});

document.getElementById("refresh-files-btn")?.addEventListener("click", () => {
  closePreview();
  loadFilesTree();
});

document.getElementById("file-modal-close")?.addEventListener("click", closePreview);
registerBackLayer(100, () => document.getElementById("file-modal")?.hidden === false, closePreview);
document.getElementById("file-modal")?.addEventListener("click", (event) => {
  if (event.target.id === "file-modal") closePreview(); // tap the scrim
});

window.loadFilesTree = loadFilesTree;

})();