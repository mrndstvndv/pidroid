// Lightweight render-performance probe. Off by default; turn it on with `?perf=1` in the page URL
// (remembered) or `localStorage["pidroid.perf"] = "1"`, off again with `?perf=0`. It shows a small
// overlay with the numbers that matter while a reply streams: how long each chat render takes, how
// many main-thread tasks block for 50ms+, and how long the page took to become typeable.
(() => {
  const KEY = "pidroid.perf";
  let on = false;
  try {
    const q = new URLSearchParams(location.search).get("perf");
    if (q === "1" || q === "0") localStorage.setItem(KEY, q);
    on = localStorage.getItem(KEY) === "1";
  } catch {}
  if (!on) return;

  const renders = [];
  let long = 0, longMs = 0, bytes = 0, updates = 0, typeableAt = 0, backs = 0, backPx = 0;
  const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

  window.__perf = {
    render(ms) {
      renders.push(ms);
      if (renders.length > 300) renders.shift();
    },
    message(size) { bytes += size; updates++; },
    scrollBack(px) { backs++; backPx = Math.max(backPx, px); },
  };

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { long++; longMs += e.duration; }
    }).observe({ entryTypes: ["longtask"] });
  } catch {}

  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;right:4px;bottom:4px;z-index:99999;margin:0;padding:6px 8px;font:10px/1.35 monospace;color:#0f0;background:rgba(0,0,0,.78);border-radius:6px;pointer-events:none;white-space:pre";
  const mount = () => {
    document.body.append(box);
    const input = document.getElementById("chat-input");
    if (input && !typeableAt) typeableAt = Math.round(performance.now());
  };
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);

  // Visual-drop probe. Each frame it reads where the last block is drawn, as the main thread sees it
  // (getBoundingClientRect). A drop that shows on screen but never here points at the compositor's
  // scroll offset rather than our layout, since the layout itself never moved.
  let touching = false, inputAt = 0, drops = 0, dropMax = 0, lastKey = "", lastTop = 0, ri = 0;
  const recent = new Array(300).fill(0);
  const onDown = (e) => { inputAt = performance.now(); if (e.type !== "wheel") touching = true; };
  const onUp = () => { touching = false; inputAt = performance.now(); };
  for (const t of ["touchstart", "pointerdown", "wheel"]) addEventListener(t, onDown, { capture: true, passive: true });
  for (const t of ["touchend", "touchcancel", "pointerup", "pointercancel"]) addEventListener(t, onUp, { capture: true, passive: true });
  const probe = () => {
    requestAnimationFrame(probe);
    const list = document.getElementById("messages-container");
    if (!list || list.offsetParent === null) { lastKey = ""; return; }
    const els = document.querySelectorAll("#messages-container [data-key]");
    const last = els[els.length - 1];
    if (!last) { lastKey = ""; return; }
    const key = last.dataset.key, top = last.getBoundingClientRect().top;
    if (key === lastKey) {
      const dy = top - lastTop;
      const scrolling = touching || performance.now() - inputAt < 1000;
      const v = !scrolling && dy > 0.5 ? dy : 0;
      if (v) { drops++; dropMax = Math.max(dropMax, v); }
      recent[ri] = v; ri = (ri + 1) % recent.length;
    }
    lastKey = key; lastTop = top;
  };
  requestAnimationFrame(probe);

  setInterval(() => {
    const f = (n) => n.toFixed(1);
    const dropRecent = Math.max(0, ...recent);
    box.textContent =
      `typeable ${typeableAt}ms\n` +
      `render p50 ${f(pct(renders, 0.5))}  p95 ${f(pct(renders, 0.95))}  max ${f(Math.max(0, ...renders))} ms\n` +
      `long tasks ${long} (${Math.round(longMs)}ms)\n` +
      `ws ${updates} msgs, ${(bytes / 1024).toFixed(0)} KB\n` +
      `scroll-backs undone ${backs} (max ${backPx.toFixed(0)}px)\n` +
      `visual drops ${drops} (max ${dropMax.toFixed(0)}px, recent ${dropRecent.toFixed(0)}px)`;
  }, 500);
})();
