// Theme editor: writes CSS custom properties on <html> and persists them in localStorage.
// The defaults mirror the :root block in style.css; anything the user sets is an inline override.
(function () {
  const KEY = "pidroid.theme";

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

  // Read the effective value: the inline override if set, else the stylesheet default.
  function readVar(name) {
    const inline = document.documentElement.style.getPropertyValue(name).trim();
    if (inline) return inline;
    const css = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return css || DEFAULTS[name] || "";
  }

  function save(theme) {
    try {
      localStorage.setItem(KEY, JSON.stringify(theme));
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
      const preset = { ...DEFAULTS, ...PRESETS[btn.dataset.preset] };
      const match = Object.keys(DEFAULTS).every((k) => {
        if (k === "--radius") return true; // compared loosely, see below
        return toHex(theme[k]) === toHex(preset[k]);
      });
      btn.classList.toggle("selected", match);
    });
  }

  function build() {
    const grid = document.getElementById("preset-grid");
    if (grid) {
      grid.innerHTML = Object.entries(PRESETS)
        .map(([name, vars]) => {
          const p = { ...DEFAULTS, ...vars };
          const swatches = ["--accent", "--bg-card", "--border", "--text-primary"]
            .map((k) => `<span class="swatch" style="background:${p[k]}"></span>`)
            .join("");
          return `<button type="button" class="preset" data-preset="${name}">${swatches}<span>${name}</span></button>`;
        })
        .join("");

      grid.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-preset]");
        if (!btn) return;
        apply({ ...DEFAULTS, ...PRESETS[btn.dataset.preset] });
      });
    }

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

    document.getElementById("theme-reset")?.addEventListener("click", () => apply({ ...DEFAULTS }));

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
    reset: () => apply({ ...DEFAULTS }),
    presets: PRESETS,
    defaults: DEFAULTS,
  };
})();
