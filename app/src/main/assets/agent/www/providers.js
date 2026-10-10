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
const modelSheetTitle = document.getElementById("model-sheet-title");
const titleModelBtn = document.getElementById("title-model-btn");
const titleModelBtnLabel = document.getElementById("title-model-btn-label");
const titleModelBtnSub = document.getElementById("title-model-btn-sub");
const MAX_RESULTS = 80;
const MAX_RECENTS = 5;
const RECENTS_KEY = "pidroid.recentModels";

let modelData = { current: "", default: "", titleModel: "", titleModelDefault: false, models: [] };
let lastSeenModel = "";

/* What the sheet is picking. "session" is the composer pill: the model this session runs on.
   "title" is the Providers tab: the model that names new sessions. One list of models serves
   both; only the target, and the rows that only make sense for one of them, differ. */
let modelSheetMode = "session";

/* ---------- recently used ----------
   The chooser is alphabetical-by-provider, so the model you actually run on can be
   hundreds of rows down. These are the last few you picked, newest first, kept in
   localStorage (ids only -- they are re-resolved against the catalogue on every open,
   so a model that disappears from the provider simply drops out). */
function readRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter(x => typeof x === "string").slice(0, MAX_RECENTS) : [];
  } catch (e) {
    return [];
  }
}

function noteRecentModel(id) {
  if (!id) return;
  const next = [id, ...readRecents().filter(x => x !== id)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch (e) {
    /* private mode: the list just will not persist */
  }
}

/* Any path that changes the model ends up here (the dialog, the Providers tab, a
   restored session), so this is the single place that keeps the recents honest. */
function trackRecentModel() {
  const cur = modelData.current;
  if (cur && cur !== lastSeenModel) {
    lastSeenModel = cur;
    noteRecentModel(cur);
  }
}

async function loadModels() {
  try {
    modelData = await api("/api/models");
    trackRecentModel();
    renderTitleModelButton();
    const cur = modelData.models.find(m => m.id === modelData.current);
    modelBtnLabel.textContent = cur ? cur.name : modelData.current;
    modelBtn.title = cur ? `${cur.name} · ${modelData.current}` : modelData.current;
    if (!modelModal.hidden) renderModels();
  } catch (e) {
    modelBtnLabel.textContent = "Model unavailable";
  }
}
window.loadModels = loadModels;

/* The summary of the title model on the Providers tab, since the list itself lives in the
   sheet. "None" is a real choice, not a placeholder: with nothing picked the session is named
   after its opening line, so the row says which of the two is in effect. A model the server is
   using by default is named too, but marked -- nobody picked it, and None is one tap away. */
function renderTitleModelButton() {
  if (!titleModelBtn) return;
  const m = modelData.models.find(m => m.id === modelData.titleModel);
  titleModelBtnLabel.textContent = m ? m.name : "None";
  const inUse = !!m;
  const sub = !inUse
    ? "Titles come from your first message"
    : [m.providerName || m.provider, modelData.titleModelDefault ? "default" : ""].filter(Boolean).join(" · ");
  titleModelBtnSub.textContent = sub;
  // The top bar's title popup names the model its Generate button would spend, so it needs to
  // hear about the preference too -- not only the tab that shows it.
  window.onTitleModelChanged?.(modelData.titleModel || "", m ? m.name : "");
}

titleModelBtn?.addEventListener("click", () => openModelModal({ mode: "title" }));

function renderModels() {
  const titleMode = modelSheetMode === "title";
  // The highlighted row is whichever model this sheet would set if you tapped it.
  const selectedId = titleMode ? modelData.titleModel : modelData.current;

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

  const providerOf = m => m.providerName || m.provider || "";
  // Capability line: "<provider> · thinking · vision · 1000K". The provider leads even
  // though the sticky group header already names it -- that header is the only thing
  // saying where a row comes from inside the recents block, and a row that quietly
  // loses its provider when you search should still say which one it is.
  const metaOf = m => {
    const bits = [];
    if (m.reasoning) bits.push("thinking");
    if (m.image) bits.push("vision");
    bits.push(`${Math.round(m.contextWindow / 1000)}K`);
    return bits.join(" · ");
  };

  const rowHtml = m => {
    const selected = m.id === selectedId;
    // The star is "default for new sessions", which is the run model's business; in title
    // mode there is nothing to default, so the row is just the row.
    const star = titleMode ? "" : `<button type="button" class="model-default${m.id === modelData.default ? " active" : ""}" data-id="${escapeHtml(m.id)}"
          title="${m.id === modelData.default ? "Default for new sessions" : "Make this the default for new sessions"}"
          aria-label="Set as default">${m.id === modelData.default ? "★" : "☆"}</button>`;
    return `
      <div class="model-item${selected ? " current" : ""}">
        <button type="button" class="model-row${selected ? " selected" : ""}" data-id="${escapeHtml(m.id)}">
          <span class="model-name">${escapeHtml(m.name)}</span>
          <span class="provider-meta"><span class="provider-tag">${escapeHtml(providerOf(m))}</span> · ${escapeHtml(metaOf(m))}</span>
        </button>
        ${star}
      </div>`;
  };

  // Clearing the title model has to be one tap in the same list, not a separate control, so it
  // sits above the catalogue. It stays put while you type: it is not a search result.
  const noneHtml = titleMode ? `
    <button type="button" class="sheet-row title-none-row" id="title-model-none">
      <span>None</span>
      <span class="sheet-row-value">${selectedId ? "Titles come from your first message" : "In use"}</span>
    </button>` : "";

  // Only while browsing: once you type, this is a filtered list and a shortcut block
  // of models that may not match would just be noise. The recents are also the run model's:
  // the last few you ran on say nothing about what you would want to name a session with.
  const byId = new Map(modelData.models.map(m => [m.id, m]));
  const recents = !titleMode && !terms.length ? readRecents().map(id => byId.get(id)).filter(Boolean) : [];
  const recentHtml = recents.length ? `
    <div class="model-group recents-head">Recently used
      <button type="button" class="link-btn" id="clear-recents" title="Forget the recently used list">clear</button>
    </div>
    ${recents.map(rowHtml).join("")}` : "";

  const catalogue = [...groups].map(([name, items]) => `
    <div class="model-group">${escapeHtml(name)}</div>
    ${items.map(rowHtml).join("")}
  `).join("");

  // The fallback hangs off the catalogue alone: the None row above it is always there, so
  // testing the whole lot would swallow the message on a search that matches nothing.
  modelList.innerHTML = noneHtml + recentHtml + (catalogue ||
    `<p class="description">No models match. Sign in to more providers in the Providers tab.</p>`);

  // The default is set with the star, so with the star gone there is nothing to foot it with.
  const def = titleMode ? undefined : modelData.models.find(m => m.id === modelData.default);
  modelDefault.textContent = def ? `★ Default: ${def.name}` : "";
  modelCount.textContent = matches.length > shown.length
    ? `${shown.length} of ${matches.length}, keep typing`
    : `${matches.length} models`;
}

/* ---------- thinking effort ----------
   The second page of the chooser: the levels the current model supports, as a radio list, applied
   with Done (or dropped with back). chat.js owns the session's thinking state and the request. */
const modelPage = document.getElementById("model-page");
const effortPage = document.getElementById("effort-page");
const effortRow = document.getElementById("effort-row");
const effortRowValue = document.getElementById("effort-row-value");
const effortList = document.getElementById("effort-list");
const EFFORT_HINTS = {
  off: "Answers straight away",
  minimal: "The lightest pass",
  low: "A quick think first",
  medium: "Balanced for everyday work",
  high: "Thinks problems through",
  xhigh: "The most thorough, and the slowest",
};
let effortChoice = null;

function renderEffortRow(info = window.thinkingInfo?.()) {
  const adjustable = info && info.levels.length > 1;
  effortRow.disabled = !adjustable;
  effortRowValue.textContent = !info ? "–" : adjustable ? window.effortLabel(info.current) : "Not adjustable";
}
window.onThinkingInfo = (info) => { if (!modelModal.hidden) renderEffortRow(info); };

function renderEffortList() {
  const info = window.thinkingInfo?.();
  if (!info) return;
  effortList.innerHTML = info.levels.map((level) => `
    <button type="button" class="effort-opt" role="radio" aria-checked="${level === effortChoice}" data-level="${escapeHtml(level)}">
      <span class="effort-text"><span class="effort-name">${escapeHtml(window.effortLabel(level))}</span>
        <span class="provider-meta">${escapeHtml(EFFORT_HINTS[level] || "")}</span></span>
      <span class="effort-radio"></span>
    </button>`).join("");
}

/* ---------- motion ----------
   The sheet rises from below the screen on an M3 Expressive spatial spring, which lands with a
   slight overshoot, while the scrim fades in on an effects spring. It drops back the same way.
   Switching pages slides the new one in from its side and springs the sheet to its new height
   (motion.js has the springs). */
const sheet = modelModal.querySelector(".sheet");
let sheetAnims = [];
let closing = false;

function stopSheetMotion() {
  for (const a of sheetAnims) a.cancel();
  sheetAnims = [];
}

const motion = (el, frames, spring) => {
  const a = window.M3Motion?.play(el, frames, spring);
  if (a) sheetAnims.push(a);
  return a;
};

const OFFSCREEN = "translateY(calc(100% + 32px))";

function showPage(effort, animate = false) {
  if (effortPage.hidden === !effort) return;
  const from = animate ? sheet.offsetHeight : 0;
  modelPage.hidden = effort;
  effortPage.hidden = !effort;
  if (effort) {
    effortChoice = window.thinkingInfo?.()?.current ?? null;
    renderEffortList();
  }
  if (!animate) return;
  stopSheetMotion();
  const to = sheet.offsetHeight;
  const page = effort ? effortPage : modelPage;
  const dx = effort ? 40 : -40; // forward comes in from the right, back from the left
  motion(page, [{ transform: `translateX(${dx}px)` }, { transform: "none" }], "spatialFast");
  motion(page, [{ opacity: 0 }, { opacity: 1 }], "effectsFast");
  const grow = from !== to && motion(sheet, [{ height: `${from}px` }, { height: `${to}px` }], "spatialDefault");
  grow?.finished.then(() => stopSheetMotion(), () => {});
}

effortRow.addEventListener("click", () => showPage(true, true));
document.getElementById("effort-back").addEventListener("click", () => showPage(false, true));
effortList.addEventListener("click", (e) => {
  const opt = e.target.closest(".effort-opt");
  if (!opt) return;
  effortChoice = opt.dataset.level;
  renderEffortList();
});
document.getElementById("effort-done").addEventListener("click", async () => {
  const info = window.thinkingInfo?.();
  if (effortChoice && info && effortChoice !== info.current) await window.setThinkingLevel?.(effortChoice);
  closeModelModal();
});

function openModelModal({ mode = "session", effort = false } = {}) {
  closing = false;
  modelSheetMode = mode;
  // Effort and the default star are about the model the session runs on, so the title sheet
  // shows neither: there is one model to pick and nothing else on the page to set.
  effortRow.hidden = mode === "title";
  modelSheetTitle.textContent = mode === "title" ? "Title generation model" : "Select model";
  modelModal.style.pointerEvents = "";
  stopSheetMotion();
  modelModal.hidden = false;
  modelSearch.value = "";
  showPage(effort);
  renderEffortRow();
  renderModels();
  loadModels();
  motion(sheet, [{ transform: OFFSCREEN }, { transform: "none" }], "spatialDefault");
  motion(modelModal, [{ opacity: 0 }, { opacity: 1 }], "effectsDefault");
}

function closeModelModal() {
  if (modelModal.hidden || closing) return;
  closing = true;
  stopSheetMotion();
  // The spring's tail is spent off screen; the page underneath is usable from the first frame.
  modelModal.style.pointerEvents = "none";
  const done = () => {
    if (!closing) return; // reopened while it was leaving
    closing = false;
    modelModal.style.pointerEvents = "";
    modelModal.hidden = true;
    stopSheetMotion();
    showPage(false);
  };
  const drop = motion(sheet, [{ transform: "none" }, { transform: OFFSCREEN }], "spatialDefault");
  motion(modelModal, [{ opacity: 1 }, { opacity: 0 }], "effectsDefault");
  if (drop) drop.finished.then(done, () => {});
  else done();
}

modelBtn.addEventListener("click", () => openModelModal());

document.getElementById("model-close").addEventListener("click", closeModelModal);
modelModal.addEventListener("click", (e) => {
  if (e.target === modelModal) closeModelModal();
});
modelSearch.addEventListener("input", renderModels);

modelList.addEventListener("click", async (e) => {
  if (e.target.closest("#clear-recents")) {
    try {
      localStorage.removeItem(RECENTS_KEY);
    } catch (err) { /* nothing to clear */ }
    renderModels();
    return;
  }

  // Title mode writes the one setting and stops: no run model to switch, no default to set.
  // The None row clears it, which the server stores as its "off" sentinel so the built-in
  // default cannot quietly take over again.
  if (modelSheetMode === "title") {
    const none = e.target.closest("#title-model-none");
    const row = e.target.closest(".model-row");
    if (!none && !row) return;
    const pick = none ? "" : row.dataset.id;
    try {
      const res = await api("/api/title-model", { model: pick });
      modelData.titleModel = res.model || "";
      // Whatever is in effect now was just picked, so it is no longer the built-in default.
      modelData.titleModelDefault = false;
      renderTitleModelButton();
      closeModelModal();
      loadModels();
    } catch (err) {
      alert(err.message);
    }
    return;
  }

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
    noteRecentModel(row.dataset.id);
    closeModelModal();
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
      buttons.push(`<button type="button" class="btn-secondary provider-icon-btn" data-act="logout" data-id="${escapeHtml(p.id)}" aria-label="Sign out of ${escapeHtml(p.name)}" title="Sign out">${icon("log-out", 18)}</button>`);
    }
    // A configured Copilot credential is an active sign-in. Don't offer Sign in and API key
    // beside Sign out; users can sign out first if they need to replace the credential.
    if (!p.configured || (p.source === "stored credential" && p.id !== "github-copilot")) {
      if (p.oauth) buttons.push(`<button type="button" class="btn-primary provider-icon-btn" data-act="oauth" data-id="${escapeHtml(p.id)}" aria-label="Sign in to ${escapeHtml(p.name)}" title="Sign in">${icon("log-in", 18)}</button>`);
      if (p.apiKey) buttons.push(`<button type="button" class="${p.oauth ? "btn-secondary" : "btn-primary"} provider-icon-btn" data-act="key" data-id="${escapeHtml(p.id)}" aria-label="Set API key for ${escapeHtml(p.name)}" title="API key">${icon("key-round", 18)}</button>`);
    }
    if (p.usage) buttons.push(`<button type="button" class="btn-secondary provider-icon-btn" data-act="usage" data-id="${escapeHtml(p.id)}" aria-label="View ${escapeHtml(p.name)} usage" title="Usage">${icon("history", 18)}</button>`);
    // Copilot account usage is shown on GitHub's billing overview, not through the
    // Command Code-specific in-app usage API. Only show the shortcut when signed in.
    if (p.id === "github-copilot" && p.configured) {
      buttons.push(`<a class="btn-secondary provider-icon-btn" href="https://github.com/settings/copilot/features" target="_blank" rel="noopener" aria-label="View GitHub Copilot usage on GitHub" title="Usage">${icon("external-link", 18)}</a>`);
    }
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
// Back leaves the effort page first, then closes the chooser.
registerBackLayer(100, () => !modelModal.hidden && !closing, () => (effortPage.hidden ? closeModelModal() : showPage(false, true)));

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
