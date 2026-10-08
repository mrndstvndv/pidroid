// Theme editor: writes CSS custom properties on <html> and persists them in localStorage.
// The defaults mirror the :root block in style.css; anything the user sets is an inline override.
(function () {
  const KEY_DARK = "pidroid.theme";
  const KEY_LIGHT = "pidroid.theme.light";
  const MODE_KEY = "pidroid.mode";

  const LIGHT_DEFAULTS = {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#ffffff",
    "--bg-card": "#ffffff",
    "--accent": "#4f46e5",
    "--accent-hover": "#4338ca",
    "--text-primary": "#111827",
    "--text-secondary": "#5b6472",
    "--border": "#dcdce1",
    "--success": "#059669",
    "--radius": "12px",
  };

  const DEFAULTS = {
    "--bg-primary": "#000000",
    "--bg-secondary": "#000000",
    "--bg-card": "#000000",
    "--accent": "#6366f1",
    "--accent-hover": "#4f46e5",
    "--text-primary": "#f3f4f6",
    "--text-secondary": "#9ca3af",
    "--border": "#222222",
    "--success": "#10b981",
    "--radius": "12px",
  };

  const LABELS = {
    "--bg-primary": "Page background",
    "--bg-secondary": "Bar background",
    "--bg-card": "Cards & bubbles",
    "--accent": "Accent",
    "--accent-hover": "Accent hover",
    "--text-primary": "Text",
    "--text-secondary": "Dim text",
    "--border": "Borders",
    "--success": "Success",
  };

  // Full light palettes, shown instead of PRESETS while the light mode is active.
  const LIGHT_PRESETS = {
    // Every preset below uses one flat colour for page, bars, cards and bubbles.
    "Daylight": { "--bg-primary": "#ffffff", "--bg-secondary": "#ffffff", "--bg-card": "#ffffff" },
    "Paper": {
      "--bg-primary": "#fbf7f0", "--bg-secondary": "#fbf7f0", "--bg-card": "#fbf7f0", "--border": "#d9cfbd",
      "--text-primary": "#2b2118", "--text-secondary": "#7a6b58", "--accent": "#b45309", "--accent-hover": "#92400e",
      "--success": "#4d7c0f",
    },
    "Mint": {
      "--bg-primary": "#f6fbf8", "--bg-secondary": "#f6fbf8", "--bg-card": "#f6fbf8", "--border": "#cbddd2",
      "--text-primary": "#10261c", "--text-secondary": "#55705f", "--accent": "#059669", "--accent-hover": "#047857",
      "--success": "#059669",
    },
    "Sky": {
      "--bg-primary": "#f7faff", "--bg-secondary": "#f7faff", "--bg-card": "#f7faff", "--border": "#cfdaec",
      "--text-primary": "#0f1c33", "--text-secondary": "#5a6b88", "--accent": "#2563eb", "--accent-hover": "#1d4ed8",
      "--success": "#16a34a",
    },
    "Rose": {
      "--bg-primary": "#fff8f9", "--bg-secondary": "#fff8f9", "--bg-card": "#fff8f9", "--border": "#e8cdd2",
      "--text-primary": "#2a1418", "--text-secondary": "#85616a", "--accent": "#e11d48", "--accent-hover": "#be123c",
      "--success": "#16a34a",
    },
    "Mono": {
      "--bg-primary": "#fafafa", "--bg-secondary": "#fafafa", "--bg-card": "#fafafa", "--border": "#dcdcdc",
      "--text-primary": "#171717", "--text-secondary": "#5f5f5f", "--accent": "#3f3f3f", "--accent-hover": "#1f1f1f",
      "--success": "#525252",
    },
  };

  const PRESETS = {
    "AMOLED Indigo": { "--bg-primary": "#000000", "--bg-secondary": "#000000", "--bg-card": "#000000" },
    "Ember": {
      "--accent": "#f97316", "--accent-hover": "#ea580c",
      "--bg-primary": "#140d08", "--bg-secondary": "#140d08", "--bg-card": "#140d08",
      "--border": "#2e1c10", "--success": "#84cc16",
    },
    "Nord": {
      "--accent": "#88c0d0", "--accent-hover": "#81a1c1",
      "--bg-primary": "#101820", "--bg-secondary": "#101820", "--bg-card": "#101820",
      "--border": "#2b3540", "--text-primary": "#eceff4", "--text-secondary": "#8fa0b3",
      "--success": "#a3be8c",
    },
    "Solarized": {
      "--accent": "#b58900", "--accent-hover": "#9a7100",
      "--bg-primary": "#0f1418", "--bg-secondary": "#0f1418", "--bg-card": "#0f1418",
      "--border": "#243038", "--text-primary": "#eee8d5", "--text-secondary": "#93a1a1",
      "--success": "#859900",
    },
    "Gruvbox": {
      "--accent": "#fabd2f", "--accent-hover": "#d5a021",
      "--bg-primary": "#161512", "--bg-secondary": "#161512", "--bg-card": "#161512",
      "--border": "#3a352c", "--text-primary": "#ebdbb2", "--text-secondary": "#a89984",
      "--success": "#b8bb26",
    },
    "Matrix": {
      "--accent": "#22c55e", "--accent-hover": "#16a34a",
      "--bg-primary": "#04140a", "--bg-secondary": "#04140a", "--bg-card": "#04140a",
      "--border": "#0f2e1a", "--text-primary": "#d1fae5", "--text-secondary": "#4d9c6b",
      "--success": "#22c55e",
    },
    "Paper": {
      "--accent": "#4f46e5", "--accent-hover": "#4338ca",
      "--bg-primary": "#241f1a", "--bg-secondary": "#241f1a", "--bg-card": "#241f1a", "--border": "#3a332b",
      "--text-primary": "#efe9e1", "--text-secondary": "#9a9086",
    },
    "Mono": {
      "--accent": "#d4d4d4", "--accent-hover": "#a3a3a3",
      "--bg-primary": "#000000", "--bg-secondary": "#000000", "--bg-card": "#000000", "--border": "#262626",
      "--text-primary": "#e5e5e5", "--text-secondary": "#8f8f8f", "--success": "#a3a3a3",
    },
  };

  // --- light / dark mode ----------------------------------------------------
  const lightQuery = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;
  const storedMode = () => {
    try { return localStorage.getItem(MODE_KEY) || "system"; } catch (e) { return "system"; }
  };
  // In the app, the host knows the real Android setting (a WebView's own prefers-color-scheme follows the app theme).
  const systemLight = () =>
    window.PidroidHost?.systemIsDark ? !window.PidroidHost.systemIsDark() : !!(lightQuery && lightQuery.matches);
  const resolveMode = (mode) => (mode === "system" ? (systemLight() ? "light" : "dark") : mode);
  let effective = document.documentElement.getAttribute("data-mode") || resolveMode(storedMode());
  const D = () => (effective === "light" ? LIGHT_DEFAULTS : DEFAULTS);
  const KEY = () => (effective === "light" ? KEY_LIGHT : KEY_DARK);
  const presetList = () => (effective === "light" ? LIGHT_PRESETS : PRESETS);
  const presetVars = (vars) => ({ ...D(), ...vars });

  // Tell the Android host the page color so it can pick status/nav bar icon contrast.
  function reportBars() {
    try { window.PidroidHost?.setBarColor?.(toHex(readVar("--bg-primary"))); } catch (e) { /* not in the app */ }
  }

  function applyMode(mode) {
    const next = resolveMode(mode);
    const root = document.documentElement;
    if (next !== effective || root.getAttribute("data-mode") !== next) {
      effective = next;
      root.setAttribute("data-mode", next);
      // Drop the previous mode's inline colors, then lay this mode's saved ones over its stylesheet palette.
      for (const name of Object.keys(DEFAULTS)) root.style.removeProperty(name);
      try {
        const saved = JSON.parse(localStorage.getItem(KEY()) || "{}");
        for (const [k, v] of Object.entries(saved)) if (v) root.style.setProperty(k, v);
      } catch (e) { /* defaults */ }
    }
    reportBars();
    const detect = document.getElementById("mode-detect");
    if (detect) {
      const bridge = !!window.PidroidHost?.systemIsDark;
      detect.textContent = `Detected system theme: ${systemLight() ? "light" : "dark"} (${bridge ? "from the app" : "from the WebView only; reinstall the latest app build"}).`;
    }
    document.querySelectorAll("#mode-seg [data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    document.querySelectorAll("#mode-seg [data-mode]").forEach((b) => b.classList.toggle("selected", b.dataset.mode === mode));
    if (typeof renderPresets === "function") renderPresets();
    syncInputs();
  }

  // The system theme changing only matters while the mode is "system".
  const onSystemThemeChange = () => {
    if (storedMode() === "system") applyMode("system");
  };
  lightQuery?.addEventListener?.("change", onSystemThemeChange);
  window.pidroidSystemThemeChanged = onSystemThemeChange; // called by the Android host



  // Read the effective value: the inline override if set, else the stylesheet default.
  function readVar(name) {
    const inline = document.documentElement.style.getPropertyValue(name).trim();
    if (inline) return inline;
    const css = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return css || D()[name] || "";
  }

  // --- frosted backdrops: html[data-blur="off"] makes the glass chrome solid (see style.css) ---
  const BLUR_KEY = "pidroid.blur";
  function applyBlur(on) {
    if (on) document.documentElement.removeAttribute("data-blur");
    else document.documentElement.setAttribute("data-blur", "off");
    const box = document.getElementById("theme-blur");
    if (box) box.checked = on;
  }
  try { applyBlur(localStorage.getItem(BLUR_KEY) !== "off"); } catch (e) { /* default: on */ }

  function save(theme) {
    try {
      localStorage.setItem(KEY(), JSON.stringify(theme));
    } catch (e) {
      /* private mode / quota: the theme just won't persist */
    }
  }

  function currentTheme() {
    const out = {};
    for (const name of Object.keys(DEFAULTS)) out[name] = readVar(name);
    return out;
  }

  function apply(theme) {
    for (const [name, value] of Object.entries(theme)) {
      document.documentElement.style.setProperty(name, value);
    }
    save(theme);
    syncInputs();
    reportBars();
  }

  // --- controls -------------------------------------------------------------

  function colorRow(name) {
    return `
      <div class="theme-row">
        <label class="theme-label" for="theme-${name}">${LABELS[name] ?? name}</label>
        <div class="theme-value">
          <input type="color" id="theme-${name}" data-var="${name}" value="${toHex(readVar(name))}" />
          <input type="text" class="theme-hex" data-hex="${name}" value="${toHex(readVar(name))}" spellcheck="false"
                 autocapitalize="off" autocomplete="off" aria-label="${LABELS[name] ?? name} hex value" />
        </div>
      </div>`;
  }

  function toHex(value) {
    const v = String(value).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    const m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (m) {
      const hex = [1, 2, 3]
        .map((i) => Math.round(parseFloat(m[i])).toString(16).padStart(2, "0"))
        .join("");
      return "#" + hex;
    }
    return "#000000";
  }

  // --- derived accent colors -------------------------------------------------
  // The accent tints used for text/icons on the page background are computed from the
  // accent itself, so a preset or hand-picked accent never leaves indigo text behind.
  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const hex = (c) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
  const luminance = (c) => {
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };
  const contrast = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  // Walk the accent toward the page background until it is readable on it (or the other
  // way, toward the text color, for text that must sit on a pale page).
  function tune(accent, bg, ratio) {
    const toward = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255];
    let best = accent;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const c = mix(accent, toward, t);
      if (contrast(c, bg) >= ratio) return c;
      best = c;
    }
    return best;
  }

  function syncDerived() {
    const accent = rgb(toHex(readVar("--accent")));
    const bg = rgb(toHex(readVar("--bg-primary")));
    const root = document.documentElement.style;
    const set = (name, value) => {
      const v = hex(value);
      if (root.getPropertyValue(name).trim() !== v) root.setProperty(name, v);
    };
    set("--accent-text", tune(accent, bg, 4.5));
    set("--accent-text-strong", tune(accent, bg, 7));
    // Faint but real edge/ring colors: mixing *toward* the page color converges on the page
    // color (invisible), so walk away from it until the fill still separates. These sit on
    // --bg-card, which a flat preset sets equal to --bg-primary, and on --bg-primary itself.
    set("--accent-edge", tune(accent, bg, 1.35));
    const onCard = rgb(toHex(readVar("--bg-card")));
    set("--accent-ring", tune(accent, onCard, 1.6));
    syncOnAccent();
  }

  function syncOnAccent() {
    const c = rgb(toHex(readVar("--accent")));
    const white = 1.05 / (luminance(c) + 0.05), black = (luminance(c) + 0.05) / 0.05;
    const fg = black >= white ? "#000000" : "#ffffff";
    if (document.documentElement.style.getPropertyValue("--on-accent").trim() !== fg) {
      document.documentElement.style.setProperty("--on-accent", fg);
    }
  }

  function syncInputs() {
    syncDerived();
    document.querySelectorAll("[data-var]").forEach((el) => {
      const hex = toHex(readVar(el.dataset.var));
      if (el.value !== hex) el.value = hex;
    });
    document.querySelectorAll("[data-hex]").forEach((el) => {
      const hex = toHex(readVar(el.dataset.hex));
      if (el.value !== hex && document.activeElement !== el) el.value = hex;
    });
    const radius = document.querySelector('[data-shape="radius"]');
    if (radius) {
      const px = parseInt(readVar("--radius"), 10) || 0;
      radius.value = px;
      const out = document.getElementById("radius-out");
      if (out) out.textContent = px + "px";
    }
    markActivePreset();
  }

  function markActivePreset() {
    const theme = currentTheme();
    document.querySelectorAll("[data-preset]").forEach((btn) => {
      const preset = presetVars(presetList()[btn.dataset.preset]);
      const match = Object.keys(DEFAULTS).every((k) => {
        if (k === "--radius") return true; // compared loosely, see below
        return toHex(theme[k]) === toHex(preset[k]);
      });
      btn.classList.toggle("selected", match);
    });
  }

  function renderPresets() {
    const grid = document.getElementById("preset-grid");
    if (!grid) return;
    grid.innerHTML = Object.entries(presetList())
      .map(([name, vars]) => {
        const p = presetVars(vars);
        const swatches = ["--accent", "--bg-card", "--border", "--text-primary"]
          .map((k) => `<span class="swatch" style="background:${p[k]}"></span>`)
          .join("");
        return `<button type="button" class="preset" data-preset="${name}">${swatches}<span>${name}</span></button>`;
      })
      .join("");
    markActivePreset();
  }

  function build() {
    const grid = document.getElementById("preset-grid");
    if (grid) {
      grid.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-preset]");
        if (!btn) return;
        apply(presetVars(presetList()[btn.dataset.preset]));
      });
      renderPresets();
    }

    document.getElementById("mode-seg")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mode]");
      if (!btn) return;
      try { localStorage.setItem(MODE_KEY, btn.dataset.mode); } catch (err) { /* won't persist */ }
      applyMode(btn.dataset.mode);
    });
    applyMode(storedMode());

    const controls = document.getElementById("theme-controls");
    if (controls) {
      controls.innerHTML = Object.keys(LABELS).map(colorRow).join("");

      controls.addEventListener("input", (e) => {
        const el = e.target;
        if (el.dataset.var) {
          apply({ ...currentTheme(), [el.dataset.var]: el.value });
        } else if (el.dataset.hex) {
          const value = el.value.trim();
          if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
            const hex = value.length === 4
              ? "#" + [...value.slice(1)].map((c) => c + c).join("")
              : value.toLowerCase();
            apply({ ...currentTheme(), [el.dataset.hex]: hex });
          }
        }
      });

      controls.addEventListener("change", (e) => {
        // A half-typed or invalid hex reverts to the color actually in effect.
        const el = e.target;
        if (!el.dataset.hex) return;
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(el.value.trim())) el.classList.remove("invalid");
        else el.classList.add("invalid");
        syncInputs();
      });
    }

    const shape = document.getElementById("theme-shape");
    if (shape) {
      shape.innerHTML = `
        <div class="theme-row">
          <label class="theme-label" for="theme-radius">Corner radius</label>
          <div class="theme-value">
            <input type="range" id="theme-radius" data-shape="radius" min="0" max="24" step="1" />
            <span class="theme-out" id="radius-out"></span>
          </div>
        </div>`;

      shape.addEventListener("input", (e) => {
        if (e.target.dataset.shape !== "radius") return;
        const px = `${e.target.value}px`;
        apply({ ...currentTheme(), "--radius": px });
        document.getElementById("radius-out").textContent = px;
      });
    }

    document.getElementById("theme-blur")?.addEventListener("change", (e) => {
      applyBlur(e.target.checked);
      try { localStorage.setItem(BLUR_KEY, e.target.checked ? "on" : "off"); } catch (err) { /* won't persist */ }
    });
    applyBlur(document.documentElement.getAttribute("data-blur") !== "off");

    document.getElementById("theme-reset")?.addEventListener("click", () => apply({ ...D() }));

    // Anything else that changes a color (e.g. another tab's script) should keep the inputs honest.
    window.addEventListener("pidroid:theme-changed", syncInputs);

    syncInputs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }

  window.pidroidTheme = {
    get: currentTheme,
    set: apply,
    reset: () => apply({ ...D() }),
    mode: () => effective,
    get presets() { return presetList(); },
    get defaults() { return D(); },
  };
})();
