// Sessions: separate conversations, each with its own transcript, model and thinking level.
// The list lives in the sidebar; switching happens straight from there.

const sidebarList = document.getElementById("sidebar-session-list");
const sessionTitle = document.getElementById("session-title");

let sessionData = { current: 0, sessions: [] };

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
  sidebarList.innerHTML = sessionData.sessions.map(s => `
    <div class="session-row${s.id === sessionData.current ? " selected" : ""}" data-id="${s.id}">
      <button type="button" class="model-row" data-act="switch">
        <span class="model-name">${escapeHtml(s.title)}</span>
        <span class="provider-meta">${sessionAgo(s.updatedAt)}${s.busy ? ` · <span class="busy-dot">${icon("circle-dot", 11, "ico-inline")} running</span>` : ""}${s.model ? " · " + escapeHtml(s.model.split("/").slice(1).join("/") || s.model) : ""}</span>
      </button>
      <button type="button" class="icon-btn" data-act="rename" title="Rename" aria-label="Rename session">${icon("pencil", 15)}</button>
      <button type="button" class="icon-btn danger" data-act="delete" title="Delete" aria-label="Delete session">${icon("trash-2", 15)}</button>
    </div>`).join("") || '<p class="description">No sessions.</p>';
}

async function loadSessions() {
  try {
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

sidebarList?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.closest(".session-row").dataset.id);
  const session = sessionData.sessions.find(s => s.id === id);
  try {
    if (btn.dataset.act === "switch") {
      if (id !== sessionData.current) await sessionsApi(`/api/sessions/${id}/switch`, "POST");
      window.closeSidebar?.();
      setTimeout(() => window.scrollChatToBottom?.(), 100);
    } else if (btn.dataset.act === "rename") {
      const title = prompt("Rename session", session?.title ?? "");
      if (title !== null) {
        await sessionsApi(`/api/sessions/${id}/rename`, "POST", { title });
        loadSessions();
      }
    } else if (btn.dataset.act === "delete") {
      if (confirm(`Delete "${session?.title}"? Any run in it is stopped, and it disappears from this list.`)) {
        await sessionsApi(`/api/sessions/${id}/delete`, "POST");
        loadSessions();
      }
    }
  } catch (err) {
    alert(err.message);
  }
});

// Server-side changes (new / switch / rename / delete, or a title set from the first message).
window.onSessionsEvent = () => {
  if (sidebar?.classList.contains("open")) loadSessions();
};

window.onSessionInfo = (session) => {
  if (session) sessionTitle.textContent = session.title;
};
