// Theme editor: writes CSS custom properties on <html> and persists them in localStorage.
// The defaults mirror the :root block in style.css; anything the user sets is an inline override.
(function () {
  const KEY_DARK = "pidroid.theme";
  const KEY_LIGHT = "pidroid.theme.light";
  const MODE_KEY = "pidroid.mode";

  const LIGHT_DEFAULTS = {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f5f5f7",
    "--bg-card": "#f0f0f3",
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
    "--bg-card": "#0d0d0d",
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
    "Daylight": {},
    "Paper": {
      "--bg-primary": "#fbf7f0", "--bg-secondary": "#f3ede2", "--bg-card": "#ece4d6", "--border": "#d9cfbd",
      "--text-primary": "#2b2118", "--text-secondary": "#7a6b58", "--accent": "#b45309", "--accent-hover": "#92400e",
      "--success": "#4d7c0f",
    },
    "Mint": {
      "--bg-primary": "#f6fbf8", "--bg-secondary": "#ecf5f0", "--bg-card": "#e2efe8", "--border": "#cbddd2",
      "--text-primary": "#10261c", "--text-secondary": "#55705f", "--accent": "#059669", "--accent-hover": "#047857",
      "--success": "#059669",
    },
    "Sky": {
      "--bg-primary": "#f7faff", "--bg-secondary": "#edf3fc", "--bg-card": "#e3ecf9", "--border": "#cfdaec",
      "--text-primary": "#0f1c33", "--text-secondary": "#5a6b88", "--accent": "#2563eb", "--accent-hover": "#1d4ed8",
      "--success": "#16a34a",
    },
    "Rose": {
      "--bg-primary": "#fff8f9", "--bg-secondary": "#fbeef0", "--bg-card": "#f6e3e6", "--border": "#e8cdd2",
      "--text-primary": "#2a1418", "--text-secondary": "#85616a", "--accent": "#e11d48", "--accent-hover": "#be123c",
      "--success": "#16a34a",
    },
  };

  const PRESETS = {
    "AMOLED Indigo": {},
    "Ember": {
      "--accent": "#f97316", "--accent-hover": "#ea580c", "--bg-card": "#140d08",
      "--border": "#2e1c10", "--success": "#84cc16",
    },
    "Nord": {
      "--accent": "#88c0d0", "--accent-hover": "#81a1c1", "--bg-card": "#101820",
      "--border": "#2b3540", "--text-primary": "#eceff4", "--text-secondary": "#8fa0b3",
      "--success": "#a3be8c",
    },
    "Solarized": {
      "--accent": "#b58900", "--accent-hover": "#9a7100", "--bg-card": "#0f1418",
      "--border": "#243038", "--text-primary": "#eee8d5", "--text-secondary": "#93a1a1",
      "--success": "#859900",
    },
    "Gruvbox": {
      "--accent": "#fabd2f", "--accent-hover": "#d5a021", "--bg-card": "#161512",
      "--border": "#3a352c", "--text-primary": "#ebdbb2", "--text-secondary": "#a89984",
      "--success": "#b8bb26",
    },
    "Matrix": {
      "--accent": "#22c55e", "--accent-hover": "#16a34a", "--bg-card": "#04140a",
      "--border": "#0f2e1a", "--text-primary": "#d1fae5", "--text-secondary": "#4d9c6b",
      "--success": "#22c55e",
    },
    "Paper": {
      "--accent": "#4f46e5", "--accent-hover": "#4338ca", "--bg-primary": "#12100e",
      "--bg-secondary": "#1a1714", "--bg-card": "#241f1a", "--border": "#3a332b",
      "--text-primary": "#efe9e1", "--text-secondary": "#9a9086",
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

  function syncInputs() {
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
