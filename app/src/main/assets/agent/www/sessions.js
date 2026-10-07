// Sessions: separate conversations, each with its own transcript, model and thinking level.
// The list lives in the sidebar; switching happens straight from there.

const sidebarList = document.getElementById("sidebar-session-list");
const sidebarSearch = document.getElementById("sidebar-search");
const sessionTitle = document.getElementById("session-title");

let sessionData = { current: 0, sessions: [] };
/* Lower-cased filter text from the sidebar search box; empty means "show everything". */
let sessionQuery = "";

async function sessionsApi(path, method = "GET", body) {
  const res = await fetch(path, method === "GET" ? {} : {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function sessionAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderSessions() {
  if (!sidebarList) return;
  // Client-side filter: the whole list is already in memory, and the box should stay
  // responsive while a name is still being typed. Filtering flattens the tree, so a branch can
  // show without the session it came from — the indent then reads as nesting that isn't there,
  // which is the lesser evil compared to hiding a session that matched.
  const shown = sessionData.sessions.filter(s => !sessionQuery || s.title.toLowerCase().includes(sessionQuery));
  // A session that was working reads "running" until its run ends, then "done" until it is opened again.
  const mark = (s) => s.busy
    ? `${icon("circle-dot", 11, "ico-inline")} running`
    : s.done ? `${icon("check", 11, "ico-inline")} done` : "";
  sidebarList.innerHTML = shown.map(s => `
    <div class="session-row${s.id === sessionData.current ? " selected" : ""}${s.depth ? " child" : ""}" data-id="${s.id}" style="--depth:${s.depth || 0}">
      <button type="button" class="model-row" data-act="switch">
        <span class="model-name">${s.depth ? `<span class="branch-glyph" aria-label="branch">${icon("git-compare", 12, "ico-inline")}</span>` : ""}${escapeHtml(s.title)}</span>
        <span class="session-meta">
          <span class="busy-dot${s.done && !s.busy ? " done" : ""}">${mark(s)}</span>
          <span class="session-ago">${sessionAgo(s.updatedAt)}</span>
        </span>
      </button>
      <button type="button" class="icon-btn session-more-btn" data-act="menu" title="Session actions" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false">${icon("ellipsis", 16)}</button>
    </div>`).join("")
    || (sessionQuery ? `<p class="description">No sessions match "${escapeHtml(sessionQuery)}".</p>` : '<p class="description">No sessions.</p>');
}

// Search box: re-render the rows on every keystroke, and clear it on Escape.
sidebarSearch?.addEventListener("input", () => {
  sessionQuery = sidebarSearch.value.trim().toLowerCase();
  closeSessionMenu();
  renderSessions();
});
sidebarSearch?.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !sidebarSearch.value) return;
  e.stopPropagation(); // don't let the sidebar's own Escape handler close it
  sidebarSearch.value = "";
  sessionQuery = "";
  renderSessions();
});
// Closing the sidebar drops the filter, so the next open starts from the full list
// instead of a stale query that hides sessions the user never asked to hide.
function clearSessionSearch() {
  if (!sidebarSearch || !sidebarSearch.value) return;
  sidebarSearch.value = "";
  sessionQuery = "";
  renderSessions();
}
window.onSidebarClosed = clearSessionSearch;

/* ---------- row menu ----------
   Rename and delete live behind one ⋮ button: two always-visible icons ate the title's width
   on a narrow sidebar, and the destructive one sat a stray tap away from every session.
   The menu is a single fixed-positioned element parked on <body> (so it escapes the sidebar's
   stacking context) and is placed under the button that opened it. */
let sessionMenu = null;
let menuSessionId = null;

function closeSessionMenu() {
  if (!sessionMenu || sessionMenu.hidden) return;
  sessionMenu.hidden = true;
  sessionMenu.innerHTML = "";
  document.querySelectorAll('.session-more-btn[aria-expanded="true"]')
    .forEach(b => b.setAttribute("aria-expanded", "false"));
  menuSessionId = null;
}

function openSessionMenu(btn, id) {
  if (!sessionMenu) {
    sessionMenu = document.createElement("div");
    sessionMenu.className = "session-menu";
    sessionMenu.setAttribute("role", "menu");
    sessionMenu.hidden = true;
    document.body.appendChild(sessionMenu);
  }
  if (!sessionMenu.hidden && menuSessionId === id) return closeSessionMenu();
  menuSessionId = id;
  sessionMenu.innerHTML = `
    <button type="button" class="session-menu-item" role="menuitem" data-menu="rename">${icon("square-pen", 16)}<span>Rename</span></button>
    <button type="button" class="session-menu-item" role="menuitem" data-menu="copy-transcript">${icon("file-text", 16)}<span>Copy transcript</span></button>
    <button type="button" class="session-menu-item" role="menuitem" data-menu="export-transcript">${icon("file-plus", 16)}<span>Export transcript</span></button>
    <button type="button" class="session-menu-item danger" role="menuitem" data-menu="delete">${icon("trash-2", 16)}<span>Delete</span></button>`;
  sessionMenu.hidden = false;
  document.querySelectorAll('.session-more-btn[aria-expanded="true"]')
    .forEach(b => b.setAttribute("aria-expanded", "false"));
  btn.setAttribute("aria-expanded", "true");

  // Anchor under the button's right edge, then keep it on screen: flip above the button
  // when there is no room below, and clamp horizontally inside the viewport.
  const r = btn.getBoundingClientRect();
  const m = sessionMenu.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(r.right - m.width, window.innerWidth - m.width - pad));
  const below = r.bottom + 6;
  const top = below + m.height > window.innerHeight - pad ? Math.max(pad, r.top - m.height - 6) : below;
  sessionMenu.style.left = `${left}px`;
  sessionMenu.style.top = `${top}px`;
  sessionMenu.querySelector("button")?.focus({ preventScroll: true });
}

async function loadSessions() {
  try {
    closeSessionMenu();
    sessionData = await sessionsApi("/api/sessions");
    renderSessions();
  } catch (e) {
    if (sidebarList) sidebarList.innerHTML = `<p class="description">Could not load sessions: ${escapeHtml(e.message)}</p>`;
  }
}

// Opening the sidebar should always show fresh data.
window.loadSidebarSessions = loadSessions;

async function newSession() {
  try {
    await sessionsApi("/api/sessions", "POST");
    window.closeSidebar?.();
    setTimeout(() => window.scrollChatToBottom?.(), 100);
  } catch (e) {
    alert(e.message);
  }
}

// New session lives in the topbar of the chat view now.
document.getElementById("new-session-btn")?.addEventListener("click", newSession);

/* ---------- transcripts ----------
   Both of these read the session out of storage on the server, so they work on any row in the
   list and not only on the session that happens to be open. The server decides what goes in the
   transcript (the whole log, tool calls and thinking included); this side only asks, and says
   where the file landed. */

/** A one-line confirmation at the bottom of the screen. Exporting is not undoable and not
    obviously finished, and an alert() for every saved file is heavier than the news is. */
let flashEl = null;
let flashTimer = null;
function flash(text, bad = false) {
  if (!flashEl) {
    flashEl = document.createElement("div");
    flashEl.className = "flash";
    flashEl.setAttribute("role", "status");
    flashEl.hidden = true;
    document.body.append(flashEl);
  }
  flashEl.textContent = text;
  flashEl.classList.toggle("bad", bad);
  flashEl.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashEl.hidden = true; }, bad ? 5000 : 3200);
}

/** chat.js owns the clipboard helper; a session export must not fail just because that file
    has not loaded yet, so the old textarea route stands in for it. */
async function putOnClipboard(text) {
  if (typeof window.copyText === "function") return window.copyText(text);
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  scratch.remove();
  return ok;
}

async function copyTranscript(id) {
  try {
    const res = await fetch(`/api/sessions/${id}/transcript`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not read the transcript (${res.status})`);
    const text = await res.text();
    flash(await putOnClipboard(text) ? "Transcript copied to the clipboard" : "Could not reach the clipboard", true);
  } catch (err) {
    flash(err.message, true);
  }
}

async function exportTranscript(id) {
  const session = sessionData.sessions.find(s => s.id === id);
  flash(`Exporting "${session?.title ?? "session"}"…`);
  try {
    const data = await sessionsApi(`/api/sessions/${id}/export`, "POST");
    const file = (data.paths?.[0] ?? "").split("/").pop();
    // The count is the only thing worth saying here: a long transcript takes a moment to write
    // and the user needs to know it landed rather than that it was big.
    flash(`Saved ${file} and its JSON to ${data.dir}`);
  } catch (err) {
    flash(err.message, true);
  }
}

sidebarList?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.closest(".session-row").dataset.id);
  const session = sessionData.sessions.find(s => s.id === id);
  try {
    if (btn.dataset.act === "switch") {
      closeSessionMenu();
      if (id !== sessionData.current) await sessionsApi(`/api/sessions/${id}/switch`, "POST");
      window.closeSidebar?.();
      setTimeout(() => window.scrollChatToBottom?.(), 100);
    } else if (btn.dataset.act === "menu") {
      openSessionMenu(btn, id);
    }
  } catch (err) {
    alert(err.message);
  }
});

// Menu items act on the session the open menu belongs to, captured before it closes.
document.addEventListener("click", async (e) => {
  const item = e.target.closest(".session-menu-item");
  if (!item || !sessionMenu || sessionMenu.hidden) return;
  const id = menuSessionId;
  const session = sessionData.sessions.find(s => s.id === id);
  closeSessionMenu();
  try {
    if (item.dataset.menu === "rename") {
      const title = prompt("Rename session", session?.title ?? "");
      if (title !== null) {
        await sessionsApi(`/api/sessions/${id}/rename`, "POST", { title });
        loadSessions();
      }
    } else if (item.dataset.menu === "copy-transcript") {
      await copyTranscript(id);
    } else if (item.dataset.menu === "export-transcript") {
      await exportTranscript(id);
    } else if (item.dataset.menu === "delete") {
      if (confirm(`Delete "${session?.title}"? Any run in it is stopped. Its transcript and every file in its workspace are deleted for good -- this cannot be undone.`)) {
        await sessionsApi(`/api/sessions/${id}/delete`, "POST");
        loadSessions();
      }
    }
  } catch (err) {
    alert(err.message);
  }
});

// Dismiss on a tap anywhere else, on Escape, and on any scroll of the list behind it
// (the menu is fixed, so it would otherwise hang detached from its row).
document.addEventListener("pointerdown", (e) => {
  if (!sessionMenu || sessionMenu.hidden) return;
  if (sessionMenu.contains(e.target) || e.target.closest(".session-more-btn")) return;
  closeSessionMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSessionMenu();
});
sidebarList?.addEventListener("scroll", closeSessionMenu, { passive: true });
window.addEventListener("resize", closeSessionMenu);
// The menu is a layer of its own: Android back closes it before the sidebar.
registerBackLayer(90, () => sessionMenu && !sessionMenu.hidden, closeSessionMenu);

// Server-side changes (new / switch / rename / delete, or a title set from the first message).
window.onSessionsEvent = () => {
  if (sidebar?.classList.contains("open")) loadSessions();
};

window.onSessionInfo = (session) => {
  if (session) sessionTitle.textContent = session.title;
};

// Closing the sidebar (scrim tap, back gesture) must not leave the row menu floating.
window.closeSessionMenu = closeSessionMenu;
