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

  setInterval(() => {
    const f = (n) => n.toFixed(1);
    box.textContent =
      `typeable ${typeableAt}ms\n` +
      `render p50 ${f(pct(renders, 0.5))}  p95 ${f(pct(renders, 0.95))}  max ${f(Math.max(0, ...renders))} ms\n` +
      `long tasks ${long} (${Math.round(longMs)}ms)\n` +
      `ws ${updates} msgs, ${(bytes / 1024).toFixed(0)} KB\n` +
      `scroll-backs undone ${backs} (max ${backPx.toFixed(0)}px)`;
  }, 500);
})();
