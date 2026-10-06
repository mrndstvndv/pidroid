/** Inline an icon as SVG markup. `cls` is appended to the class list. */
function icon(name, size = 18, cls = "") {
  const body = LUCIDE[name];
  if (!body) return "";
  return `<svg class="ico${cls ? " " + cls : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Same icon, wrapped so it sits inline with text (flex-friendly, baseline aligned). */
function iconTag(name, size = 16, cls = "") {
  return `<span class="ico-wrap${cls ? " " + cls : ""}">${icon(name, size)}</span>`;
}

/** Fill in every <span data-icon="name"> in a root with the real SVG. */
function renderIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    const size = Number(el.dataset.size) || 18;
    el.innerHTML = icon(el.dataset.icon, size);
    el.classList.add("ico-slot");
    el.removeAttribute("data-icon");
  });
}

/** Set the text of a button that carries an icon, keeping the icon in place. */
function setLabel(el, text) {
  const label = el && el.querySelector(".btn-label");
  if (label) label.textContent = text;
  else if (el) el.textContent = text;
}

// Agent tool name → Lucide icon. Names are matched as a lowercased, stripped-down
// string ("CompatBashTool39600f" → "compatbashtool39600f"), longest pattern first,
// so e.g. todowrite is never mistaken for write.
const TOOL_ICONS = [
  ["todowrite", "list-todo"], ["todos", "list-todo"], ["todo", "list-todo"],
  ["updateplan", "list-checks"], ["plan", "list-checks"],
  ["findfiles", "folder-search"], ["glob", "folder-search"],
  ["grep", "search"], ["search", "search"],
  ["read", "file-text"], ["view", "file-text"],
  ["write", "file-plus"], ["create", "file-plus"],
  ["edit", "pencil"], ["patch", "pencil"],
  ["bash", "terminal"], ["shell", "terminal"], ["exec", "terminal"],
  ["evalruntime", "code"], ["runjs", "code"],
  ["reloadextensions", "refresh-cw"], ["reloadui", "refresh-cw"], ["reload", "refresh-cw"],
  ["restartserver", "power"],
  ["thinking", "brain"], ["reason", "brain"],
];

function toolIcon(name) {
  const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [needle, iconName] of TOOL_ICONS) if (key.includes(needle)) return iconName;
  return "wrench";
}

window.icon = icon;
window.iconTag = iconTag;
window.renderIcons = renderIcons;
window.setLabel = setLabel;
window.toolIcon = toolIcon;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => renderIcons());
} else {
  renderIcons();
}
