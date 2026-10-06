// Providers tab: model picker + provider login (OAuth / API key).
// Login flows run on the server; their prompts and links arrive as "login" WebSocket events.

const providersList = document.getElementById("providers-list");
const providerFilter = document.getElementById("provider-filter");
const loginModal = document.getElementById("login-modal");
const loginTitle = document.getElementById("login-title");
const loginBody = document.getElementById("login-body");

let providers = [];
let activeLogin = null; // { loginId, providerId }

const API_TIMEOUT_MS = 20000;

async function api(path, body) {
  // A hung request used to leave the placeholder ("Loading providers...") on screen
  // forever, so every call is bounded and reports a real error instead.
  const res = await fetch(path, body === undefined ? { signal: AbortSignal.timeout(API_TIMEOUT_MS) } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error);
  return data;
}

/* ---------- Model chooser ---------- */

const modelBtn = document.getElementById("model-btn");
const modelBtnLabel = document.getElementById("model-btn-label");
const modelModal = document.getElementById("model-modal");
const modelSearch = document.getElementById("model-search");
const modelList = document.getElementById("model-list");
const modelCount = document.getElementById("model-count");
const modelDefault = document.getElementById("model-default");
const MAX_RESULTS = 80;

let modelData = { current: "", default: "", models: [] };

async function loadModels() {
  try {
    modelData = await api("/api/models");
    const cur = modelData.models.find(m => m.id === modelData.current);
    modelBtnLabel.textContent = cur ? cur.name : modelData.current;
    modelBtn.title = modelData.current;
    if (!modelModal.hidden) renderModels();
  } catch (e) {
    modelBtnLabel.textContent = "Model unavailable";
  }
}
window.loadModels = loadModels;

function renderModels() {
  // Every whitespace-separated term must match the id, name or provider name.
  const terms = modelSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = modelData.models.filter(m => {
    const hay = `${m.id} ${m.name} ${m.providerName || ""}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  const shown = matches.slice(0, MAX_RESULTS);

  const groups = new Map();
  for (const m of shown) {
    const key = m.providerName || m.provider;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  modelList.innerHTML = [...groups].map(([name, items]) => `
    <div class="model-group">${escapeHtml(name)}</div>
    ${items.map(m => `
      <div class="model-item">
        <button type="button" class="model-row${m.id === modelData.current ? " selected" : ""}" data-id="${escapeHtml(m.id)}">
          <span class="model-name">${escapeHtml(m.name)}</span>
          <span class="provider-meta">${m.reasoning ? "thinking · " : ""}${m.image ? "vision · " : ""}${Math.round(m.contextWindow / 1000)}K</span>
        </button>
        <button type="button" class="model-default${m.id === modelData.default ? " active" : ""}" data-id="${escapeHtml(m.id)}"
          title="${m.id === modelData.default ? "Default for new sessions" : "Make this the default for new sessions"}"
          aria-label="Set as default">${m.id === modelData.default ? "★" : "☆"}</button>
      </div>`).join("")}
  `).join("") || `<p class="description">No models match. Sign in to more providers in the Providers tab.</p>`;

  const def = modelData.models.find(m => m.id === modelData.default);
  modelDefault.textContent = def ? `Default for new sessions: ${def.name}` : "";
  modelCount.textContent = matches.length > shown.length
    ? `Showing ${shown.length} of ${matches.length} — keep typing`
    : `${matches.length} models`;
}

modelBtn.addEventListener("click", () => {
  modelModal.hidden = false;
  modelSearch.value = "";
  renderModels();
  loadModels();
  modelSearch.focus();
});

document.getElementById("model-close").addEventListener("click", () => (modelModal.hidden = true));
modelModal.addEventListener("click", (e) => {
  if (e.target === modelModal) modelModal.hidden = true;
});
modelSearch.addEventListener("input", renderModels);

modelList.addEventListener("click", async (e) => {
  // The star sets the default for *new* sessions and leaves this one alone, so the dialog stays
  // open and you can keep browsing; tapping the row itself switches the session and closes.
  const star = e.target.closest(".model-default");
  if (star) {
    star.disabled = true;
    try {
      const res = await api("/api/model/default", { model: star.dataset.id });
      modelData.default = res.default || star.dataset.id;
      renderModels();
      loadModels();
    } catch (err) {
      alert(err.message);
      star.disabled = false;
    }
    return;
  }
  const row = e.target.closest(".model-row");
  if (!row) return;
  try {
    await api("/api/model", { model: row.dataset.id });
    modelModal.hidden = true;
    loadModels();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("refresh-models-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setLabel(btn, "Refreshing...");
  try {
    const result = await api("/api/models/refresh", {});
    const failed = Object.entries(result.errors || {});
    if (failed.length) alert(failed.map(([id, msg]) => `${id}: ${msg}`).join("\n"));
    await loadModels();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    setLabel(btn, "Refresh catalogs");
  }
});

/* ---------- Provider list ---------- */

async function loadProviders() {
  try {
    const data = await api("/api/providers");
    providers = data.providers || [];
    renderProviders();
    loadModels();
  } catch (e) {
    providers = [];
    const msg = e.name === "TimeoutError" || e.name === "AbortError" ? `request timed out after ${API_TIMEOUT_MS / 1000}s` : e.message;
    providersList.innerHTML = `<p class="provider-meta">Could not load providers: ${escapeHtml(msg)}</p>`;
  }
}
window.loadProviders = loadProviders;

function renderProviders() {
  const q = providerFilter.value.trim().toLowerCase();
  const shown = providers.filter(p => !q || p.id.includes(q) || p.name.toLowerCase().includes(q));
  providersList.innerHTML = shown.map(p => {
    const status = p.configured
      ? `<span class="provider-meta ok">${icon("circle-check", 13, "ico-inline")} ${escapeHtml(p.source || p.type || "configured")}</span>`
      : `<span class="provider-meta">Not signed in · ${p.modelCount} models</span>`;
    const buttons = [];
    if (p.configured && p.source === "stored credential") {
      buttons.push(`<button class="btn-secondary icon-btn-text" data-act="logout" data-id="${escapeHtml(p.id)}">${icon("log-out", 14)}<span class="btn-label">Sign out</span></button>`);
    }
    if (!p.configured || p.source === "stored credential") {
      if (p.oauth) buttons.push(`<button class="btn-primary icon-btn-text" data-act="oauth" data-id="${escapeHtml(p.id)}">${icon("log-in", 14)}<span class="btn-label">Sign in</span></button>`);
      if (p.apiKey) buttons.push(`<button class="${p.oauth ? "btn-secondary" : "btn-primary"} icon-btn-text" data-act="key" data-id="${escapeHtml(p.id)}">${icon("key-round", 14)}<span class="btn-label">API key</span></button>`);
    }
    if (p.usage) buttons.push(`<button class="btn-secondary icon-btn-text" data-act="usage" data-id="${escapeHtml(p.id)}">${icon("history", 14)}<span class="btn-label">Usage</span></button>`);
    return `
      <div class="provider-item">
        <div class="provider-info"><strong>${escapeHtml(p.name)}</strong>${status}</div>
        <div class="provider-actions">${buttons.join("")}</div>
      </div>`;
  }).join("") || "<p>No providers match.</p>";
}

providerFilter.addEventListener("input", renderProviders);

providersList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const provider = providers.find(p => p.id === btn.dataset.id);
  if (!provider) return;
  try {
    if (btn.dataset.act === "logout") {
      if (confirm(`Sign out of ${provider.name}?`)) {
        await api(`/api/providers/${encodeURIComponent(provider.id)}/logout`, {});
        loadProviders();
      }
    } else if (btn.dataset.act === "oauth") {
      await startLogin(provider, "oauth");
    } else if (btn.dataset.act === "key") {
      provider.apiKeyLogin ? await startLogin(provider, "api_key") : showKeyForm(provider);
    } else if (btn.dataset.act === "usage") {
      showUsage(provider);
    }
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- Login dialog ---------- */

function openModal(title) {
  loginTitle.textContent = title;
  loginBody.innerHTML = "";
  loginModal.hidden = false;
}

function closeModal() {
  if (activeLogin) {
    if (activeLogin.loginId) api(`/api/login/${activeLogin.loginId}/cancel`, {}).catch(() => {});
    activeLogin = null;
  }
  loginModal.hidden = true;
}

document.getElementById("login-close").addEventListener("click", closeModal);
registerBackLayer(110, () => !loginModal.hidden, closeModal);
registerBackLayer(100, () => !modelModal.hidden, () => (modelModal.hidden = true));

function showKeyForm(provider) {
  openModal(`${provider.name} API key`);
  loginBody.innerHTML = `
    <input type="password" class="field" id="key-input" placeholder="Paste API key" autocomplete="off" />
    <button class="btn-primary" id="key-save">Save</button>`;
  document.getElementById("key-save").addEventListener("click", async () => {
    const key = document.getElementById("key-input").value;
    try {
      await api(`/api/providers/${encodeURIComponent(provider.id)}/key`, { key });
      closeModal();
      loadProviders();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ---------- Usage panel ---------- */

// Command Code reports credits as dollars (1 credit = $1 of model usage on a
// full-allowance model), so the numbers are money rather than a credit count.
function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  // Per-request costs are fractions of a cent; two decimals would round them to $0.00.
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function compact(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

/** "4h 58m" / "6d 22h" / "now". */
function untilWhen(at) {
  const remaining = at - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "now";
  const minutes = Math.floor(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function usageWindowHtml(w) {
  const pct = w.cap > 0 ? Math.max(0, Math.min(100, (w.used / w.cap) * 100)) : 0;
  const level = w.exceeded || pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
  const right = w.exceeded
    ? `${money(w.used)} of ${money(w.cap)} · limit reached, resets in ${untilWhen(w.resetAt)}`
    : `${money(w.used)} of ${money(w.cap)} · resets in ${untilWhen(w.resetAt)}`;
  return `
    <div class="usage-row">
      <div class="usage-row-head"><span>${escapeHtml(w.label)}</span><span>${escapeHtml(right)}</span></div>
      <div class="usage-bar"><span class="${level}" style="width:${pct.toFixed(1)}%"></span></div>
    </div>`;
}

function usageHtml(usage) {
  const credits = usage.credits || {};
  const rows = [];

  const balances = [
    credits.monthly !== undefined ? `${money(credits.monthly)} monthly credits left` : "",
    credits.purchased ? `${money(credits.purchased)} purchased` : "",
    credits.free ? `${money(credits.free)} free` : "",
  ].filter(Boolean);
  rows.push(`
    <div class="usage-top">
      ${usage.plan ? `<span class="usage-plan">${escapeHtml(usage.plan)}${usage.planStatus && usage.planStatus !== "active" ? ` · ${escapeHtml(usage.planStatus)}` : ""}</span>` : ""}
      ${balances.length ? `<span class="provider-meta">${escapeHtml(balances.join(" · "))}</span>` : ""}
    </div>`);

  if (usage.periodEnd) {
    rows.push(`<p class="provider-meta">Billing period ends ${escapeHtml(new Date(usage.periodEnd).toLocaleDateString())} · renews in ${untilWhen(usage.periodEnd)}</p>`);
  }

  const windows = usage.windows || [];
  rows.push(...windows.map(usageWindowHtml));
  if (!windows.length) rows.push(`<p class="provider-meta">No rolling windows on this plan — the credit balance is the only limit.</p>`);

  const t = usage.totals;
  if (t) {
    const stats = [
      t.requests !== undefined ? `${compact(t.requests)} requests` : "",
      t.cost !== undefined ? `${money(t.cost)} used this period` : "",
      t.averageCost !== undefined ? `${money(t.averageCost)} avg/request` : "",
      t.successRate !== undefined ? `${t.successRate.toFixed(0)}% success` : "",
      t.tokensIn !== undefined ? `${compact(t.tokensIn)} in / ${compact(t.tokensOut)} out tokens` : "",
    ].filter(Boolean);
    rows.push(`<div class="usage-totals">${stats.map(s => `<span>${escapeHtml(s)}</span>`).join("")}</div>`);
  }

  rows.push(`
    <p class="usage-note">Windows open on your first request and reset a fixed 5 hours (or 7 days) later; usage never carries between windows. Pay-as-you-go credits are never capped.</p>
    <button class="btn-secondary icon-btn-text" id="usage-refresh">${icon("refresh-cw", 14)}<span class="btn-label">Refresh</span></button>`);
  return rows.join("");
}

function showUsage(provider) {
  openModal(`${provider.name} usage`);
  void renderUsage(provider.id);
}

async function renderUsage(providerId) {
  loginBody.innerHTML = `<p class="provider-meta">Loading usage…</p>`;
  try {
    const { usage } = await api(`/api/providers/${encodeURIComponent(providerId)}/usage`);
    loginBody.innerHTML = usageHtml(usage);
  } catch (err) {
    loginBody.innerHTML = `<p class="provider-meta">Could not load usage: ${escapeHtml(err.message)}</p>
      <button class="btn-secondary icon-btn-text" id="usage-retry">${icon("refresh-cw", 14)}<span class="btn-label">Retry</span></button>`;
  }
  const retry = loginBody.querySelector("#usage-refresh, #usage-retry");
  retry?.addEventListener("click", () => renderUsage(providerId));
}

async function startLogin(provider, type) {
  openModal(`Sign in to ${provider.name}`);
  loginBody.innerHTML = "<p>Starting...</p>";
  // Events can arrive before the start request returns; adopt the id from the first matching one.
  activeLogin = { loginId: null, providerId: provider.id };
  try {
    const { loginId } = await api(`/api/providers/${encodeURIComponent(provider.id)}/login`, { type });
    if (activeLogin && activeLogin.loginId === null) activeLogin.loginId = loginId;
  } catch (err) {
    activeLogin = null;
    loginModal.hidden = true;
    throw err;
  }
}

function appendBody(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  loginBody.appendChild(wrap);
  return wrap;
}

function renderNotify(event) {
  if (event.type === "auth_url") {
    // Opens in the system browser (the WebView hands external URLs off).
    appendBody(`
      ${event.instructions ? `<p>${escapeHtml(event.instructions)}</p>` : ""}
      <a class="login-link" href="${escapeHtml(event.url)}" target="_blank" rel="noopener">${iconTag("external-link", 14)} Open sign-in page</a>`);
  } else if (event.type === "device_code") {
    appendBody(`
      <p>Enter this code at <a href="${escapeHtml(event.verificationUri)}" target="_blank" rel="noopener">${escapeHtml(event.verificationUri)}</a>:</p>
      <div class="device-code">${escapeHtml(event.userCode)}</div>
      <a class="login-link" href="${escapeHtml(event.verificationUri)}" target="_blank" rel="noopener">${iconTag("external-link", 14)} Open verification page</a>`);
  } else if (event.type === "info") {
    const links = (event.links || []).map(l => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label || l.url)}</a>`).join("<br>");
    appendBody(`<p>${escapeHtml(event.message)}</p>${links ? `<p>${links}</p>` : ""}`);
  } else if (event.type === "progress") {
    appendBody(`<p class="provider-meta">${escapeHtml(event.message)}</p>`);
  }
}

function renderPrompt(loginId, promptId, prompt) {
  const wrap = appendBody(`<p>${escapeHtml(prompt.message)}</p>`);
  const submit = async (value) => {
    wrap.querySelectorAll("button,input").forEach(el => (el.disabled = true));
    try {
      await api(`/api/login/${loginId}/answer`, { promptId, value });
    } catch (err) {
      alert(err.message);
    }
  };

  if (prompt.type === "select") {
    prompt.options.forEach(opt => {
      const b = document.createElement("button");
      b.className = "btn-secondary";
      b.style.cssText = "display:block;width:100%;margin-bottom:6px;text-align:left";
      b.textContent = opt.label + (opt.description ? ` — ${opt.description}` : "");
      b.addEventListener("click", () => submit(opt.id));
      wrap.appendChild(b);
    });
    return;
  }

  const input = document.createElement("input");
  input.className = "field";
  input.type = prompt.type === "secret" ? "password" : "text";
  input.placeholder = prompt.placeholder || (prompt.type === "manual_code" ? "Paste the code or redirect URL" : "");
  input.autocomplete = "off";
  const ok = document.createElement("button");
  ok.className = "btn-primary";
  ok.textContent = "Continue";
  ok.addEventListener("click", () => submit(input.value));
  wrap.append(input, ok);
  input.focus();
}

window.onProviderEvent = (data) => {
  if (data.event === "providers_changed") {
    loadProviders();
    return;
  }
  const p = data.payload;
  if (!activeLogin) return;
  if (activeLogin.loginId === null && p.providerId === activeLogin.providerId) activeLogin.loginId = p.loginId;
  if (p.loginId !== activeLogin.loginId) return;

  if (p.kind === "notify") renderNotify(p.event);
  else if (p.kind === "prompt") renderPrompt(p.loginId, p.promptId, p.prompt);
  else if (p.kind === "done") {
    activeLogin = null;
    loginModal.hidden = true;
    loadProviders();
  } else if (p.kind === "error" || p.kind === "cancelled") {
    appendBody(`<p style="color:var(--danger-text)">${escapeHtml(p.message || "Login cancelled")}</p>`);
    activeLogin = null;
  }
};

// Providers is the default Settings tab, so it must populate itself on startup:
// nothing else calls loadProviders() until the tab button is tapped.
loadProviders();
