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

/* ---------- selection mode ----------
   The row menu deletes one session per trip, which on a phone means walking the list one ⋮ tap at
   a time. A long press on a row starts selecting instead: from then on a tap marks a session rather
   than opening it, the ⋮ button steps aside, and a bar over the list carries the count plus the one
   action the mode exists for. Back or Escape leaves it.

   That bar and the ticks come and go together, on whether anything is marked: the mode has nothing
   to say to a list where every row is unticked, and a disabled delete button over it is just a
   line of chrome. So the first mark brings the bar in, unticking the last one takes the whole mode
   back off -- which also means there is no way to be left inside a mode whose only exit button has
   just been hidden. */
const selectBar = document.getElementById("sidebar-select-bar");
const selectCount = document.getElementById("sidebar-select-count");
const selectDelete = document.getElementById("sidebar-select-delete");
const selectClear = document.getElementById("sidebar-select-clear");
const selectAll = document.getElementById("sidebar-select-all");
const selectedIds = new Set();
let selectMode = false;

function setSelectMode(on) {
  if (selectMode === on) return;
  selectMode = on;
  if (!on) selectedIds.clear();
  if (selectBar) selectBar.hidden = !on || !selectedIds.size;
  sidebarList?.classList.toggle("selecting", on);
  renderSessions();
}

/** The rows the list is actually showing, filter applied. Everything that acts on "all" acts on
    these, never on the whole list: while a search box has a word in it, the user is looking at a
    handful of sessions and means those. */
function shownSessions() {
  return sessionData.sessions.filter(s => !sessionQuery || s.title.toLowerCase().includes(sessionQuery));
}

function updateSelectBar() {
  const n = selectedIds.size;
  // The bar belongs to the marks, not to the mode: it shows while at least one row is marked.
  if (selectBar) selectBar.hidden = !selectMode || !n;
  if (selectCount) selectCount.textContent = n ? `${n} selected` : "Nothing selected";
  if (selectDelete) selectDelete.disabled = !n;
  if (selectAll) {
    // One button for both directions, because what the user means is "all of them": once every
    // shown row is marked it reads None, and tapping it drops the selection rather than re-adding it.
    const shown = shownSessions();
    const everyMarked = shown.length > 0 && shown.every((s) => selectedIds.has(s.id));
    selectAll.textContent = everyMarked ? "None" : "All";
    selectAll.disabled = !shown.length;
    const what = sessionQuery ? "the matching sessions" : "every session";
    selectAll.title = everyMarked ? `Clear the selection` : `Select ${what}`;
    selectAll.setAttribute("aria-label", everyMarked ? "Clear selection" : `Select ${what}`);
  }
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  // Unmarking the last row leaves nothing for the mode to act on, so it ends -- bar, ticks and all.
  if (selectMode && !selectedIds.size) return setSelectMode(false);
  updateSelectBar();
  renderSessions();
}

/** Mark every shown row, or clear them all if they are already marked. */
function toggleSelectAll() {
  const shown = shownSessions();
  const everyMarked = shown.length > 0 && shown.every((s) => selectedIds.has(s.id));
  shown.forEach((s) => (everyMarked ? selectedIds.delete(s.id) : selectedIds.add(s.id)));
  // Same rule as a single unmark: an empty selection ends the mode with it.
  if (selectMode && !selectedIds.size) return setSelectMode(false);
  updateSelectBar();
  renderSessions();
}

/** Delete every selected session, deepest branch first. The server refuses to delete a session that
    still has branches -- it would empty their inherited history -- so the branches have to go before
    their parent; a parent and its branch picked together must not fail just because of the order the
    rows happen to be listed in. One refusal does not stop the rest: the names of what survived are
    said out loud, because a session that quietly stayed behind is the worst outcome here. */
async function deleteSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const rows = ids.map((id) => sessionData.sessions.find((s) => s.id === id)).filter(Boolean);
  const what = rows.length === 1 ? `"${rows[0].title}"` : `${rows.length} sessions`;
  const tail = rows.length === 1 ? "Any run in it is stopped. Its transcript and every file in its workspace are deleted"
                               : "Any run in them is stopped. Their transcripts and every file in their workspaces are deleted";
  if (!confirm(`Delete ${what}? ${tail} for good -- this cannot be undone.`)) return;
  rows.sort((a, b) => (b.depth || 0) - (a.depth || 0));
  let deleted = 0;
  const refused = [];
  for (const s of rows) {
    try {
      await sessionsApi(`/api/sessions/${s.id}/delete`, "POST");
      deleted++;
    } catch (err) {
      refused.push(err.message);
    }
  }
  setSelectMode(false);
  await loadSessions();
  if (refused.length) flash(`${deleted} deleted, ${refused.length} kept: ${refused[0]}`, true);
  else flash(`Deleted ${deleted} session${deleted === 1 ? "" : "s"}`);
}

function renderSessions() {
  if (!sidebarList) return;
  // Client-side filter: the whole list is already in memory, and the box should stay
  // responsive while a name is still being typed. Filtering flattens the tree, so a branch can
  // show without the session it came from — the indent then reads as nesting that isn't there,
  // which is the lesser evil compared to hiding a session that matched.
  const shown = shownSessions();
  // A session that was working reads "running" until its run ends, then "done" until it is opened again.
  const mark = (s) => s.busy
    ? `${icon("circle-dot", 11, "ico-inline")} running`
    : s.done ? `${icon("check", 11, "ico-inline")} done` : "";
  // The open session keeps its accent border while selecting -- it is a fact about the list, not a
  // choice -- and a marked row adds a tick on top, so both read at a glance.
  sidebarList.innerHTML = shown.map(s => `
    <div class="session-row${s.id === sessionData.current ? " selected" : ""}${selectedIds.has(s.id) ? " checked" : ""}${s.depth ? " child" : ""}" data-id="${s.id}" style="--depth:${s.depth || 0}"${selectedIds.has(s.id) ? ' aria-selected="true"' : ""}>
      <button type="button" class="model-row" data-act="switch">
        ${selectMode ? `<span class="select-tick" aria-hidden="true">${icon(selectedIds.has(s.id) ? "check" : "square", 15)}</span>` : ""}
        <span class="model-name">${s.depth ? `<span class="branch-glyph" aria-label="branch">${icon("git-compare", 12, "ico-inline")}</span>` : ""}${escapeHtml(s.title)}</span>
        <span class="session-meta">
          <span class="busy-dot${s.done && !s.busy ? " done" : ""}">${mark(s)}</span>
          <span class="session-ago">${sessionAgo(s.updatedAt)}</span>
        </span>
      </button>
      ${selectMode ? "" : `<button type="button" class="icon-btn session-more-btn" data-act="menu" title="Session actions" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false">${icon("ellipsis", 16)}</button>`}
    </div>`).join("")
    || (sessionQuery ? `<p class="description">No sessions match "${escapeHtml(sessionQuery)}".</p>` : '<p class="description">No sessions.</p>');
  updateSelectBar();
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

/* ---------- long press to select ----------
   A press is timed, not measured, because there is nothing to measure against: the finger may be
   resting on a title or on the row's padding. Movement cancels it (a press that slides is a scroll,
   and on a phone the list scrolls under a resting finger), as does lifting before the timer fires --
   which is what keeps an ordinary tap on a session an ordinary tap. */
const LONG_PRESS_MS = 450;
const PRESS_SLOP = 10;
let pressTimer = null;
let pressId = null;
let pressX = 0;
let pressY = 0;
/** Set when a press turned into a selection: the tap the finger's lift then produces belongs to
    that gesture and must not also open the session underneath it. Held for a moment rather than
    cleared on pointerup, because the click arrives after it, and given an expiry so a stray long
    press can never swallow the next genuine tap. */
let suppressClickUntil = 0;

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
  pressId = null;
}

sidebarList?.addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".session-row");
  if (!row || e.target.closest(".session-more-btn")) return;
  cancelPress();
  pressId = Number(row.dataset.id);
  pressX = e.clientX;
  pressY = e.clientY;
  pressTimer = setTimeout(() => {
    const id = pressId;
    pressId = null;
    pressTimer = null;
    navigator.vibrate?.(15);
    setSelectMode(true);
    toggleSelect(id);
    suppressClickUntil = Date.now() + 700;
  }, LONG_PRESS_MS);
});
sidebarList?.addEventListener("pointermove", (e) => {
  if (pressTimer && Math.hypot(e.clientX - pressX, e.clientY - pressY) > PRESS_SLOP) cancelPress();
});
// pointercancel is what a scroll and a system gesture send; pointerup is a plain lift.
sidebarList?.addEventListener("pointerup", cancelPress);
sidebarList?.addEventListener("pointercancel", cancelPress);
sidebarList?.addEventListener("pointerleave", cancelPress);
// Android still raises its own long-press menu on a row after a while; the row's gesture is ours.
// (-webkit-touch-callout is already off app-wide, this is the right-click / context menu path.)
sidebarList?.addEventListener("contextmenu", (e) => e.preventDefault());

selectDelete?.addEventListener("click", deleteSelected);
selectAll?.addEventListener("click", toggleSelectAll);
selectClear?.addEventListener("click", () => setSelectMode(false));
// Escape and Android back leave selection mode before they close the sidebar itself.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectMode) {
    e.stopPropagation();
    setSelectMode(false);
  }
});
registerBackLayer(85, () => selectMode, () => setSelectMode(false));

sidebarList?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.closest(".session-row").dataset.id);
  const session = sessionData.sessions.find(s => s.id === id);
  try {
    if (btn.dataset.act === "switch") {
      closeSessionMenu();
      // The tap that ends a long press is already spoken for.
      if (Date.now() < suppressClickUntil) return;
      if (selectMode) return toggleSelect(id);
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

// A selection is a thing in a sidebar that is no longer there, so closing the sidebar drops it --
// reopening should not find a bar over the list with rows still marked from an earlier trip in.
const leaveSelectMode = () => setSelectMode(false);
if (typeof window.onSidebarClosed === "function") {
  const afterClose = window.onSidebarClosed;
  window.onSidebarClosed = () => { leaveSelectMode(); afterClose(); };
} else {
  window.onSidebarClosed = leaveSelectMode;
}

window.onSessionInfo = (session) => {
  if (session) sessionTitle.textContent = session.title;
};

// Closing the sidebar (scrim tap, back gesture) must not leave the row menu floating.
window.closeSessionMenu = closeSessionMenu;

/* ---------- top bar title popup ----------
   The session list is where renaming lived, but naming is something you do to the conversation in
   front of you, not to a row you have to find first. The popup is the top bar's own, and does only
   that: the current title in an editable box, and a button to have a model write a better one. The
   list stays behind the burger -- a popup that also navigates is a menu with a text field in it. */
const titleBtn = document.getElementById("session-btn");
let titlePop = null;
let titleBusy = false;
let popOpenedAt = 0;
/** Human name of the model a generated title will come from: the title-model preference while one
    is picked, and empty otherwise (the server then uses the session's own model). */
let titleModelName = "";

function closeTitlePop() {
  if (!titlePop || titlePop.hidden) return;
  titlePop.hidden = true;
  titleBtn?.setAttribute("aria-expanded", "false");
  titleBusy = false;
}

/** The Generate row's label, which names the model it will spend -- so it follows the title-model
    preference whenever that changes. */
function renderGenerateRow() {
  const button = titlePop?.querySelector('[data-act="generate"]');
  if (!button || button.disabled) return;
  button.innerHTML = `${icon("sparkles", 16)}<span>Generate${titleModelName ? ` with ${escapeHtml(titleModelName)}` : ""}</span>`;
}

function openTitlePop() {
  if (!titleBtn) return;
  if (!titlePop) {
    titlePop = document.createElement("div");
    titlePop.className = "title-pop";
    titlePop.setAttribute("role", "dialog");
    titlePop.setAttribute("aria-label", "Session title");
    titlePop.hidden = true;
    titlePop.innerHTML = `
      <div class="title-pop-head">Session title</div>
      <div class="title-pop-edit">
        <input type="text" class="field title-pop-input" id="title-pop-input" maxlength="80"
               autocomplete="off" autocapitalize="sentences" spellcheck="false" aria-label="Session title" />
        <button type="button" class="title-pop-save" id="title-pop-save">Save</button>
      </div>
      <button type="button" class="session-menu-item" data-act="generate" id="title-pop-generate"></button>`;
    document.body.appendChild(titlePop);

    titlePop.querySelector("#title-pop-save").addEventListener("click", () => saveTypedTitle());
    titlePop.querySelector('[data-act="generate"]').addEventListener("click", () => generateTitle());
    // Enter saves without dismissing the popup: a second idea about the name usually follows the
    // first, and having to reopen the box to say it is what makes people give up renaming.
    titlePop.querySelector("#title-pop-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      saveTypedTitle();
    });
  }
  if (!titlePop.hidden) return closeTitlePop();

  const input = titlePop.querySelector("#title-pop-input");
  input.value = sessionTitle.textContent.trim();
  const generate = titlePop.querySelector('[data-act="generate"]');
  generate.disabled = false;
  renderGenerateRow();
  titlePop.hidden = false;
  titleBtn.setAttribute("aria-expanded", "true");
  placeTitlePop();
  popOpenedAt = performance.now();

  // Focus last: it raises the keyboard, which is a resize, and the popup has to already be on
  // screen to survive being re-anchored by it.
  input.focus({ preventScroll: true });
  input.select();
}

/** Put the popup under the title, centred on it, then keep it inside the viewport. The title sits
    in the middle of the bar, so its own edges are the only thing that can push the box off screen --
    but the keyboard can: it shrinks the viewport from the bottom, and a popup anchored under a top
    bar stays put only if it is clamped against the height that is left. */
function placeTitlePop() {
  if (!titlePop || titlePop.hidden) return;
  const r = titleBtn.getBoundingClientRect();
  const box = titlePop.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(r.left + r.width / 2 - box.width / 2, window.innerWidth - box.width - pad));
  const below = r.bottom + 6;
  titlePop.style.left = `${left}px`;
  titlePop.style.top = `${Math.max(pad, Math.min(below, window.innerHeight - box.height - pad))}px`;
}

async function saveTypedTitle() {
  if (!titlePop || titleBusy) return;
  const input = titlePop.querySelector("#title-pop-input");
  const title = input.value.trim();
  if (!title) return flash("A session needs a name", true);
  if (title === sessionTitle.textContent.trim()) return closeTitlePop();
  try {
    await sessionsApi(`/api/sessions/${sessionData.current}/rename`, "POST", { title });
    // The server answers with the current session and broadcasts the change, which is what
    // repaints the top bar and the sidebar; this only clears the popup's own copy.
    input.value = title;
    closeTitlePop();
  } catch (err) {
    flash(err.message, true);
  }
}

/** Have a model write the title for this conversation. The server does the work and the rename, and
    sends back what it settled on, so the box never shows a title the session does not have. */
async function generateTitle() {
  if (!titlePop || titleBusy) return;
  const button = titlePop.querySelector('[data-act="generate"]');
  const input = titlePop.querySelector("#title-pop-input");
  titleBusy = true;
  button.disabled = true;
  button.innerHTML = `<span class="shimmer">Writing a title…</span>`;
  try {
    const data = await sessionsApi(`/api/sessions/${sessionData.current}/title`, "POST");
    input.value = data.title;
    sessionTitle.textContent = data.title;
    flash(`Titled with ${data.model}`);
    closeTitlePop();
  } catch (err) {
    button.disabled = false;
    button.innerHTML = `${icon("sparkles", 16)}<span>Try again</span>`;
    flash(err.message, true);
  } finally {
    titleBusy = false;
  }
}

// The title model preference decides which model Generate names, so it follows it into the popup.
window.onTitleModelChanged = (key, name) => {
  titleModelName = name || key || "";
  renderGenerateRow();
};

titleBtn?.addEventListener("click", openTitlePop);
document.addEventListener("pointerdown", (e) => {
  if (!titlePop || titlePop.hidden) return;
  if (titlePop.contains(e.target) || titleBtn?.contains(e.target)) return;
  // A tap that lands a moment after opening is the tail of the tap that opened it -- the WebView
  // hands over a synthesized pointerdown once focus has moved and the keyboard is on its way up.
  // Treating that as "somewhere else" closed the popup under the user's thumb.
  if (performance.now() - popOpenedAt < 400) return;
  closeTitlePop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTitlePop();
});
// Raising the soft keyboard is a resize, and this popup holds the focused input -- so closing on
// every resize closed it a fraction of a second after it opened, which is exactly what it did. A
// height change while the box has focus only re-anchors it; anything else (a rotation, the window
// itself changing) still dismisses it.
let popWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (!titlePop || titlePop.hidden) return;
  const widthChanged = window.innerWidth !== popWidth;
  popWidth = window.innerWidth;
  if (!widthChanged && titlePop.contains(document.activeElement)) return placeTitlePop();
  closeTitlePop();
});
// Above the sidebar menu (90) but below the settings sheet, so back unwinds the title popup first.
registerBackLayer(95, () => titlePop && !titlePop.hidden, closeTitlePop);
