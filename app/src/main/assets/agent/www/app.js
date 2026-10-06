// Frontend application logic, screen switching & WebSocket connection
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

/* ---------- soft keyboard / viewport ----------
   Android WebViews behave in one of two ways when the keyboard opens: adjustResize
   shrinks the layout viewport, or adjustPan slides the whole view up
   (visualViewport.offsetTop > 0) to reveal the focused composer. Under adjustPan the
   topbar is pushed off the top of the screen, which is why typing made it disappear.
   Pinning #app to the visual viewport and cancelling the pan works in both cases; when
   the WebView already resizes, offsetTop is 0 and the height matches, so it is a no-op.

   While a field is focused the WebView also lets a drag move the page itself (the
   visual viewport pans, or the document focus-scrolls), which slid the whole chat view
   around -- topbar and composer leaving with it. Correcting on the visualViewport event
   alone is too late for that, because the event is delivered after the frame it belongs
   to has already been composited. So stay pinned every frame while something is focused
   and stop the moment nothing is; idle reading costs nothing. */
const appEl = document.getElementById("app");

let pinFrame = 0;

function syncViewport() {
  if (!appEl) return;
  // Only the message list scrolls. A window scroll here is focus scrolling or the
  // keyboard pan leaking through, and it would move the whole app shell.
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  const vv = window.visualViewport;
  if (!vv) return;
  const pan = vv.offsetTop || 0;
  appEl.style.height = `${vv.height}px`;
  appEl.style.transform = pan ? `translateY(${-pan}px)` : "";
  // The same rectangle in app-local coordinates: -pan (the app's own transform) plus
  // pan lands on 0, the top of the visual viewport. Overlays (the model chooser) size
  // themselves from these, so they cover exactly the visible area and nothing hides
  // behind the soft keyboard, whatever the WebView did to the layout viewport.
  appEl.style.setProperty("--vv-top", `${pan}px`);
  appEl.style.setProperty("--vv-h", `${vv.height}px`);
}

function fieldFocused() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
}

function pinViewport() {
  syncViewport();
  pinFrame = fieldFocused() ? requestAnimationFrame(pinViewport) : 0;
}

function startPin() {
  if (appEl && window.visualViewport && !pinFrame) pinFrame = requestAnimationFrame(pinViewport);
}

if (appEl && window.visualViewport) {
  visualViewport.addEventListener("resize", syncViewport);
  visualViewport.addEventListener("scroll", syncViewport);
  window.addEventListener("scroll", syncViewport);
  window.addEventListener("orientationchange", () => setTimeout(syncViewport, 250));
  document.addEventListener("focusin", startPin);
  startPin(); // one pass on load; the loop stops again immediately when nothing is focused
}

/* ---------- chrome touch guard ----------
   A touch-drag starting on fixed chrome (composer, topbar, settings head/tabs) must
   never move the chat view. CSS touch-action already forbids the vertical pan, but a
   WebView can still turn a drag on the focused input into a visual-viewport pan or a
   focus scroll, which slides the whole shell -- topbar and composer included -- with
   the finger. So kill vertical pans at the source with a non-passive touchmove guard.
   Only vertical-dominant moves are cancelled, so horizontal caret sliding and tab
   swipes keep working, and taps are untouched. The exception is the composer textarea
   that has grown past its cap (.tall): it scrolls internally, so cancelling there would
   trap the caret in the middle of a long draft. */
const guardRoots = ".composer, .topbar, .settings-head, .settings-tabs";
let guardStart = null;

document.addEventListener("touchstart", (e) => {
  const t = e.touches?.[0];
  guardStart = t ? {
    x: t.clientX,
    y: t.clientY,
    chrome: !!(e.target?.closest?.(guardRoots)),
    // A capped, scrollable composer field owns its own vertical drag.
    scroller: !!e.target?.closest?.(".chat-input-bar textarea.tall"),
  } : null;
}, { passive: true });

document.addEventListener("touchmove", (e) => {
  if (!guardStart?.chrome || guardStart.scroller || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - guardStart.x;
  const dy = t.clientY - guardStart.y;
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) e.preventDefault();
}, { passive: false });

/* ---------- floating chrome sizing ----------
   The topbar and the composer are absolutely positioned so the message list scrolls
   under them and their backdrop-filter has something to blur. That means their heights
   are no longer reserved by flex layout, so publish them as --chrome-top / --chrome-bottom
   and let .chat-messages reserve the same space as scroll padding. Measured with a
   ResizeObserver rather than hardcoded: the topbar grows with a long session title, and
   the composer changes height with the queue bar, the safe-area inset and the keyboard. */
const chromeEls = [
  [".topbar", "--chrome-top"],
  [".composer", "--chrome-bottom"],
];

function syncChromeHeights() {
  for (const [sel, prop] of chromeEls) {
    const el = document.querySelector(sel);
    // Hidden chrome (topbar in Settings) measures 0, which is what we want to reserve.
    const h = el && el.offsetParent !== null ? Math.round(el.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty(prop, `${h}px`);
  }
}

if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(syncChromeHeights);
  for (const [sel] of chromeEls) {
    const el = document.querySelector(sel);
    if (el) ro.observe(el);
  }
}
window.addEventListener("resize", syncChromeHeights);
// Fonts settle after first paint and shift the bars by a pixel or two.
window.addEventListener("load", syncChromeHeights);
syncChromeHeights();

/* ---------- edge-to-edge: status bar inset ----------
   The Android host draws the page under the status bar and reports its height (dp == CSS px).
   WebView only sometimes fills env(safe-area-inset-top) itself, hence the bridge. */
function syncSafeTop() {
  const h = Number(window.PidroidHost?.statusBarHeight?.());
  if (h > 0) document.documentElement.style.setProperty("--safe-top", `${h}px`);
  syncChromeHeights();
}
window.addEventListener("load", syncSafeTop);
window.addEventListener("resize", syncSafeTop);
syncSafeTop();

/* ---------- screens: chat (main) and settings ---------- */

const chatScreen = document.getElementById("screen-chat");
const settingsScreen = document.getElementById("screen-settings");
const artifactsScreen = document.getElementById("screen-artifacts");
const settingsBack = document.getElementById("settings-back");
const topbar = document.querySelector(".topbar");

// Which full-screen takeover is open ("settings" | "artifacts"), or null for chat.
let overlay = null;

// Settings and Artifacts are full-screen takeovers: the chat topbar goes away and their head
// (styled as a topbar) sits at the very top, so nothing of the chat peeks through.
function showScreen(name) {
  const next = name === "settings" || name === "artifacts" ? name : null;
  chatScreen.classList.toggle("active", !next);
  settingsScreen.classList.toggle("active", next === "settings");
  artifactsScreen.classList.toggle("active", next === "artifacts");
  if (topbar) topbar.hidden = !!next;
  overlay = next;

  syncChromeHeights(); // the hidden topbar must stop reserving space

  if (next === "settings") window.loadProviders?.(); // cheap (~5 kB) and keeps the list honest after a sign-in elsewhere
  else if (next === "artifacts") window.loadArtifacts?.();
  else window.scrollChatToBottom?.();
}

/* ---------- back navigation ----------
   One place decides what "back" closes, so the Android back gesture (and any later caller) needs no
   per-screen knowledge. Anything dismissable registers a layer: isOpen() says whether it is showing,
   close() dismisses it. The open layer with the highest priority wins, so the topmost thing on screen
   closes first. Layers read live DOM state rather than tracking open/close calls, because several of
   them are toggled directly via `hidden` from more than one place.
   The native host calls window.pidroidBack(); false means nothing was open, and the app may exit. */
const backLayers = [];
window.registerBackLayer = (priority, isOpen, close) => {
  backLayers.push({ priority, isOpen, close });
  backLayers.sort((x, y) => y.priority - x.priority);
};
window.pidroidBack = () => {
  for (const layer of backLayers) {
    if (!layer.isOpen()) continue;
    layer.close();
    return true;
  }
  return false;
};
window.addEventListener("load", () => { reportedCanGoBack = null; reportBackState(); });

// The native back handler has to be armed before the gesture starts (predictive back), so tell the host
// whenever "something is open" flips. A MutationObserver on class/hidden changes covers every layer without
// each one having to announce itself; the check is a handful of DOM reads, batched to one per frame.
let reportedCanGoBack = null;
function reportBackState() {
  const open = backLayers.some((layer) => layer.isOpen());
  if (open === reportedCanGoBack) return;
  reportedCanGoBack = open;
  try { window.PidroidHost?.setCanGoBack?.(open); } catch (e) { /* not in the app */ }
}
let backCheckQueued = false;
new MutationObserver(() => {
  if (backCheckQueued) return;
  backCheckQueued = true;
  requestAnimationFrame(() => { backCheckQueued = false; reportBackState(); });
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });

// Priorities: dialogs 100, sidebar 80, in-screen detail 60, full-screen takeovers 40.
registerBackLayer(40, () => overlay !== null, () => showScreen("chat"));

// Tab switching inside Settings
document.querySelectorAll(".tab-btn").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

    button.classList.add("active");
    document.getElementById(`tab-${button.dataset.tab}`)?.classList.add("active");

    if (button.dataset.tab === "workspace") window.loadFilesTree?.();
    if (button.dataset.tab === "extensions") window.loadExtensionsTab?.();
    if (button.dataset.tab === "providers") window.loadProviders?.();
    if (button.dataset.tab === "changes") window.loadChanges?.();
  });
});

settingsBack?.addEventListener("click", () => showScreen("chat"));
document.getElementById("open-artifacts-btn")?.addEventListener("click", () => {
  window.closeSidebar?.();
  showScreen("artifacts");
});
document.getElementById("open-settings-btn")?.addEventListener("click", () => {
  window.closeSidebar?.();
  showScreen("settings");
});

// Restart: the Android host restarts the whole agent process (works with a broken server, leaves safe mode).
// A plain browser has no host, so fall back to the server's own restart endpoint.
const restartBtn = document.getElementById("restart-btn");
restartBtn?.addEventListener("click", async () => {
  if (!confirm("Restart the agent? Running sessions resume afterwards.")) return;
  restartBtn.disabled = true;
  if (window.PidroidHost?.restart) {
    window.PidroidHost.restart();
    return;
  }
  try {
    const res = await fetch("/api/restart", { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    setTimeout(() => location.reload(), 2500);
  } catch (err) {
    alert("Restart failed: " + (err instanceof Error ? err.message : err));
    restartBtn.disabled = false;
  }
});

/* ---------- sidebar ---------- */

const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("sidebar-scrim");
const burger = document.getElementById("burger-btn");

function openSidebar() {
  sidebar.classList.add("open");
  scrim.hidden = false;
  burger.setAttribute("aria-expanded", "true");
  window.loadSidebarSessions?.();
}

function closeSidebar() {
  sidebar.classList.remove("open");
  scrim.hidden = true;
  burger.setAttribute("aria-expanded", "false");
  window.closeSessionMenu?.();
  window.onSidebarClosed?.();
}

window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;

burger?.addEventListener("click", openSidebar);
scrim?.addEventListener("click", closeSidebar);
document.getElementById("sidebar-close")?.addEventListener("click", closeSidebar);
registerBackLayer(80, () => sidebar.classList.contains("open"), closeSidebar);
// The title doubles as a shortcut to the session list.
document.getElementById("session-btn")?.addEventListener("click", openSidebar);


// WebSocket Setup
let socket = null;
let reloadTimeout = null;

function setConnected(online) {
  document.getElementById("conn-dot")?.classList.toggle("online", online);
}

function connectWebSocket() {
  socket = new WebSocket(wsUrl);

  socket.onopen = () => setConnected(true);

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === "agent_view") {
        window.onAgentView?.(data.payload);
      } else if (data.event === "sessions_changed") {
        window.onSessionsEvent?.();
      } else if (data.event === "changes") {
        window.onChangesEvent?.();
      } else if (data.event === "login" || data.event === "providers_changed") {
        window.onProviderEvent?.(data);
      } else if (data.event === "ui_reload") {
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
    setConnected(false);
    setTimeout(connectWebSocket, 2000);
  };
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Colour a unified diff (from changes.ts) for display. Shared: the Changes tab renders
   checkpoint diffs with it, and so does the chat's tool preview. */
function colorDiff(text) {
  return escapeHtml(text).split("\n").map(line => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("===")) return `<span class="hunk">${line}</span>`;
    if (line.startsWith("@@")) return `<span class="hunk">${line}</span>`;
    if (line.startsWith("+")) return `<span class="add">${line}</span>`;
    if (line.startsWith("-")) return `<span class="del">${line}</span>`;
    return line;
  }).join("\n");
}

// WebSocket Setup
connectWebSocket();
