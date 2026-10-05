// Frontend application logic & WebSocket connection
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

const messagesContainer = document.getElementById("messages-container");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const runtimeBadge = document.getElementById("runtime-badge");
const systemInfo = document.getElementById("system-info");
const filesListContainer = document.getElementById("files-list-container");

// Tab Switching
document.querySelectorAll(".tab-btn").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

    button.classList.add("active");
    const tabId = `tab-${button.dataset.tab}`;
    document.getElementById(tabId)?.classList.add("active");

    if (button.dataset.tab === "state") fetchState();
    if (button.dataset.tab === "workspace") loadWorkspaceFiles();
  });
});

// WebSocket Setup
let socket = null;
let reloadTimeout = null;

function connectWebSocket() {
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    statusDot.className = "status-dot online";
    statusText.textContent = "Online";
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === "connected") {
        runtimeBadge.textContent = `Bun v${data.payload.version}`;
      } else if (data.event === "message") {
        appendMessage(data.payload.role, data.payload.content);
      } else if (data.event === "ui_reload" || data.event === "file_modified") {
        console.log("[pidroid] UI file modified, hot-reloading:", data.payload);
        // Instant CSS / Page Hot-Reload
        clearTimeout(reloadTimeout);
        reloadTimeout = setTimeout(() => {
          const stylesheet = document.getElementById("main-stylesheet");
          if (stylesheet && data.payload?.filename?.endsWith(".css")) {
            stylesheet.href = `style.css?v=${Date.now()}`;
          } else {
            window.location.reload();
          }
        }, 300);
      }
    } catch (e) {
      console.error("WS Parse error:", e);
    }
  };

  socket.onclose = () => {
    statusDot.className = "status-dot";
    statusText.textContent = "Reconnecting...";
    setTimeout(connectWebSocket, 2000);
  };
}

function appendMessage(role, text) {
  const msgEl = document.createElement("div");
  msgEl.className = `message ${role}`;
  msgEl.innerHTML = `
    <div class="message-content">${escapeHtml(text)}</div>
    <div class="message-meta">${role === "user" ? "You" : "Agent"} • ${new Date().toLocaleTimeString()}</div>
  `;
  messagesContainer.appendChild(msgEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Chat Form Submit
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json();
    if (data.error) alert(data.error);
  } catch (err) {
    console.error("Failed to send message:", err);
  }
});

// Load Message History
async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    const data = await res.json();
    if (data.messages && data.messages.length > 0) {
      messagesContainer.innerHTML = "";
      data.messages.forEach(m => appendMessage(m.role, m.content));
    }
  } catch (e) {
    console.error("Could not load message history", e);
  }
}

// Load System State
async function fetchState() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    systemInfo.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    systemInfo.textContent = "Error loading status: " + e;
  }
}

// Load Workspace Files
async function loadWorkspaceFiles() {
  try {
    const res = await fetch("/api/files/list?dir=www");
    const data = await res.json();
    if (filesListContainer && data.files) {
      filesListContainer.innerHTML = data.files.map(f => `
        <div class="file-item">
          <span>📄 <strong>${escapeHtml(f.name)}</strong></span>
          <span style="color: var(--text-secondary); font-size: 0.8rem;">${(f.size / 1024).toFixed(1)} KB</span>
        </div>
      `).join("");
    }
  } catch (e) {
    if (filesListContainer) filesListContainer.innerHTML = "<p>Error loading files.</p>";
  }
}

document.getElementById("refresh-state-btn")?.addEventListener("click", fetchState);
document.getElementById("refresh-files-btn")?.addEventListener("click", loadWorkspaceFiles);

// Initial Load
connectWebSocket();
loadHistory();
