// Usage tab: local rollups of the provider usage ledger recorded by the token-usage extension.

const usageSummary = document.getElementById("usage-summary");
const usageSessionList = document.getElementById("usage-session-list");
const usageDailyChart = document.getElementById("usage-daily-chart");
const usageWeeklyChart = document.getElementById("usage-weekly-chart");
const usageMonthlyChart = document.getElementById("usage-monthly-chart");
const refreshUsageButton = document.getElementById("refresh-usage-btn");
const usageProviderFilter = document.getElementById("usage-provider-filter");
const usageModelFilter = document.getElementById("usage-model-filter");
const usageFilterClear = document.getElementById("usage-filter-clear");
let usageLoading = false;

function usageEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function populateUsageFilters(filters) {
  if (!usageProviderFilter || !usageModelFilter) return;
  const providers = filters?.providers || [];
  const availableModels = filters?.models || [];
  const selectedProvider = usageProviderFilter.value || filters?.provider || "";
  const providerValues = new Set(providers);
  const provider = providerValues.has(selectedProvider) ? selectedProvider : "";
  usageProviderFilter.innerHTML = '<option value="">All providers</option>' + providers.map((value) =>
    `<option value="${usageEscape(value)}">${usageEscape(value)}</option>`).join("");
  usageProviderFilter.value = provider;

  const modelRows = provider ? availableModels.filter((row) => row.provider === provider) : availableModels;
  const selectedModel = usageModelFilter.value || filters?.model || "";
  const modelKeys = new Set(modelRows.map((row) => `${row.provider}/${row.model}`));
  const model = modelKeys.has(selectedModel) ? selectedModel : "";
  usageModelFilter.innerHTML = '<option value="">All models</option>' + modelRows.map((row) => {
    const key = `${row.provider}/${row.model}`;
    return `<option value="${usageEscape(key)}">${usageEscape(row.provider)} · ${usageEscape(row.model)}</option>`;
  }).join("");
  usageModelFilter.value = model;
}

function showUsageError(message) {
  const html = `<p class="description">Could not load usage stats: ${usageEscape(message)}</p>`;
  for (const target of [usageSummary, usageSessionList, usageDailyChart, usageWeeklyChart, usageMonthlyChart]) {
    if (target) target.innerHTML = html;
  }
}

function usageNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function usageTokens(value) {
  return usageNumber(value).toLocaleString();
}

function usageCompact(value) {
  const n = usageNumber(value);
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString();
}

function usageMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Not reported";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number(value));
}

function usageBreakdown(row) {
  return `Input ${usageTokens(row.inputTokens)} · Output ${usageTokens(row.outputTokens)} · ` +
    `Cache read ${usageTokens(row.cacheReadTokens)} · Cache write ${usageTokens(row.cacheWriteTokens)}`;
}

function usageCard(label, row, note = "") {
  return `
    <article class="usage-card">
      <span class="usage-card-label">${escapeHtml(label)}</span>
      <strong class="usage-card-value">${usageCompact(row.tokens)}</strong>
      <span class="usage-card-sub">tokens</span>
      <span class="usage-card-detail">${usageTokens(row.responses)} model responses · ${usageMoney(row.cost)}</span>
      ${note ? `<span class="usage-card-detail">${escapeHtml(note)}</span>` : ""}
    </article>`;
}

function renderUsageSummary(data) {
  const all = data.allTime || {};
  const sessionAverage = all.sessions ? Math.round(usageNumber(all.tokens) / all.sessions) : 0;
  usageSummary.innerHTML = [
    usageCard("All time", all, all.sessions ? `Average ${usageCompact(sessionAverage)} tokens per tracked session` : "No tracked sessions yet"),
    usageCard("Today", data.today || {}),
    usageCard("This week", data.thisWeek || {}),
    usageCard("This month", data.thisMonth || {}),
  ].join("") + `
    <div class="usage-breakdown">
      <strong>All-time breakdown</strong>
      <span>${usageBreakdown(all)}</span>
      <span>${usageTokens(all.sessions)} tracked sessions · ${usageTokens(all.responses)} model responses</span>
    </div>`;
}

function renderUsageSessions(rows) {
  if (!rows?.length) {
    usageSessionList.innerHTML = '<p class="description">No usage recorded yet. It will appear here after the next model response.</p>';
    return;
  }
  usageSessionList.innerHTML = rows.map((row) => {
    const title = row.title || `Session ${row.id}`;
    const latest = row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : "";
    return `
      <article class="usage-session-card">
        <div class="usage-session-head">
          <strong>${escapeHtml(title)}</strong>
          <strong class="usage-session-total">${usageTokens(row.tokens)} tokens</strong>
        </div>
        <div class="usage-session-meta">${usageBreakdown(row)}</div>
        <div class="usage-session-meta">${usageTokens(row.responses)} model responses · ${usageMoney(row.cost)}${latest ? ` · Last used ${escapeHtml(latest)}` : ""}</div>
      </article>`;
  }).join("");
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fillDaily(rows, count) {
  const byKey = new Map((rows || []).map((row) => [row.bucket, row]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (count - 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = localDateKey(date);
    out.push(byKey.get(key) || { bucket: key, tokens: 0, responses: 0, cost: null });
  }
  return out;
}

function fillWeekly(rows, count) {
  const byKey = new Map((rows || []).map((row) => [row.bucket, row]));
  const current = new Date();
  current.setHours(0, 0, 0, 0);
  current.setDate(current.getDate() - ((current.getDay() + 6) % 7));
  const start = new Date(current);
  start.setDate(start.getDate() - 7 * (count - 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i * 7);
    const key = localDateKey(date);
    out.push(byKey.get(key) || { bucket: key, tokens: 0, responses: 0, cost: null });
  }
  return out;
}

function fillMonthly(rows, count) {
  const byKey = new Map((rows || []).map((row) => [row.bucket, row]));
  const now = new Date();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    out.push(byKey.get(key) || { bucket: key, tokens: 0, responses: 0, cost: null });
  }
  return out;
}

function chartLabel(key, kind) {
  if (kind === "month") {
    const [year, month] = key.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "short" });
  }
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

function renderUsageChart(target, rows, kind) {
  const max = Math.max(0, ...rows.map((row) => usageNumber(row.tokens)));
  target.innerHTML = `<div class="usage-bars">${rows.map((row) => {
    const tokens = usageNumber(row.tokens);
    const height = max ? Math.max(tokens ? 3 : 0, (tokens / max) * 100) : 0;
    const label = chartLabel(row.bucket, kind);
    const title = `${row.bucket}: ${usageTokens(tokens)} tokens, ${usageTokens(row.responses)} responses`;
    return `
      <div class="usage-bar-col" title="${escapeHtml(title)}">
        <span class="usage-bar-number">${tokens ? usageCompact(tokens) : ""}</span>
        <div class="usage-bar-track"><span class="usage-bar-fill" style="height:${height.toFixed(1)}%"></span></div>
        <span class="usage-bar-label">${escapeHtml(label)}</span>
      </div>`;
  }).join("")}</div>`;
}

function snapshotUsageStats(snapshot, providerFilter, modelFilter, visibleSessions = []) {
  const records = (snapshot?.records || []).map((raw) => ({
    sessionId: usageNumber(raw.sessionId),
    capturedAt: usageNumber(raw.capturedAt),
    provider: String(raw.provider || "unknown"),
    model: String(raw.model || "unknown"),
    inputTokens: usageNumber(raw.inputTokens),
    outputTokens: usageNumber(raw.outputTokens),
    cacheReadTokens: usageNumber(raw.cacheReadTokens),
    cacheWriteTokens: usageNumber(raw.cacheWriteTokens),
    tokens: usageNumber(raw.tokens),
    cost: raw.cost === null || raw.cost === undefined ? null : usageNumber(raw.cost),
  }));
  const providers = [...new Set(records.map((row) => row.provider))].sort();
  const modelMap = new Map();
  for (const row of records) modelMap.set(`${row.provider}/${row.model}`, { provider: row.provider, model: row.model });
  const models = [...modelMap.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  const filtered = records.filter((row) =>
    (!providerFilter || row.provider === providerFilter) &&
    (!modelFilter || `${row.provider}/${row.model}` === modelFilter));

  const aggregate = (items) => {
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, tokens = 0;
    let cost = 0, pricedResponses = 0;
    const sessionIds = new Set();
    for (const row of items) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      cacheReadTokens += row.cacheReadTokens;
      cacheWriteTokens += row.cacheWriteTokens;
      tokens += row.tokens;
      sessionIds.add(row.sessionId);
      if (row.cost !== null) { cost += row.cost; pricedResponses++; }
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, tokens,
      cost: pricedResponses ? cost : null, pricedResponses, responses: items.length, sessions: sessionIds.size };
  };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monday = new Date(todayStart);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const between = (start) => filtered.filter((row) => row.capturedAt >= start);
  const groupRows = (items, keyFor) => {
    const groups = new Map();
    for (const row of items) {
      const key = keyFor(row);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, group]) => ({ bucket, ...aggregate(group) }));
  };
  const weekKey = (row) => {
    const date = new Date(row.capturedAt);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return localDateKey(date);
  };
  const monthKey = (row) => {
    const date = new Date(row.capturedAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  };

  const sessionMap = new Map();
  for (const row of snapshot?.sessions || []) sessionMap.set(usageNumber(row.id), row);
  for (const row of visibleSessions || []) sessionMap.set(usageNumber(row.id), row);
  const perSession = new Map();
  for (const row of filtered) {
    const group = perSession.get(row.sessionId) || [];
    group.push(row);
    perSession.set(row.sessionId, group);
  }
  const sessions = [...perSession.entries()].map(([id, items]) => {
    const metadata = sessionMap.get(id) || {};
    return { id, title: metadata.title || `Session ${id}`, createdAt: usageNumber(metadata.createdAt),
      lastUsedAt: Math.max(...items.map((row) => row.capturedAt)), ...aggregate(items) };
  }).sort((a, b) => b.tokens - a.tokens);

  const dailyStart = new Date(todayStart);
  dailyStart.setDate(dailyStart.getDate() - 29);
  const weeklyStart = new Date(monday);
  weeklyStart.setDate(weeklyStart.getDate() - 77);
  const monthlyStart = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
  return {
    generatedAt: snapshot?.generatedAt || Date.now(),
    filters: { provider: providerFilter, model: modelFilter, providers, models },
    allTime: aggregate(filtered),
    today: aggregate(between(todayStart)),
    thisWeek: aggregate(between(monday.getTime())),
    thisMonth: aggregate(between(monthStart)),
    sessions,
    daily: groupRows(between(dailyStart.getTime()), (row) => localDateKey(new Date(row.capturedAt))),
    weekly: groupRows(between(weeklyStart.getTime()), weekKey),
    monthly: groupRows(between(monthlyStart), monthKey),
  };
}

async function loadSnapshotStats(provider, model) {
  const fileUrl = `/api/files/read?path=${encodeURIComponent(".tmp/token-usage-stats.json")}`;
  const fileResponse = await fetch(fileUrl);
  const fileData = await fileResponse.json().catch(() => ({}));
  if (!fileResponse.ok || fileData.error) throw new Error(fileData.error || fileResponse.statusText || "Usage snapshot not found");
  let snapshot;
  try { snapshot = JSON.parse(fileData.content); }
  catch { throw new Error("Usage snapshot is unreadable; refresh after the next model response."); }
  let visibleSessions = [];
  try {
    const sessionResponse = await fetch("/api/sessions");
    const sessionData = await sessionResponse.json();
    if (sessionResponse.ok && Array.isArray(sessionData.sessions)) visibleSessions = sessionData.sessions;
  } catch {}
  return snapshotUsageStats(snapshot, provider, model, visibleSessions);
}

async function loadUsageStats() {
  if (usageLoading) return;
  usageLoading = true;
  if (refreshUsageButton) refreshUsageButton.disabled = true;
  try {
    const params = new URLSearchParams();
    if (usageProviderFilter?.value) params.set("provider", usageProviderFilter.value);
    if (usageModelFilter?.value) params.set("model", usageModelFilter.value);
    const query = params.toString();
    const provider = usageProviderFilter?.value || "";
    const model = usageModelFilter?.value || "";
    const response = await fetch(`/api/usage/stats${query ? `?${query}` : ""}`);
    let data;
    if (response.status === 404) {
      // The app may be running its recovery server after a failed source-server restart. Its
      // file-read API still works, so use the extension's local JSON snapshot in that case.
      data = await loadSnapshotStats(provider, model);
    } else {
      data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || response.statusText || "Request failed");
    }
    populateUsageFilters(data.filters);
    renderUsageSummary(data);
    renderUsageSessions(data.sessions);
    renderUsageChart(usageDailyChart, fillDaily(data.daily, 30), "day");
    renderUsageChart(usageWeeklyChart, fillWeekly(data.weekly, 12), "week");
    renderUsageChart(usageMonthlyChart, fillMonthly(data.monthly, 12), "month");
  } catch (error) {
    showUsageError(error instanceof Error ? error.message : String(error));
  } finally {
    usageLoading = false;
    if (refreshUsageButton) refreshUsageButton.disabled = false;
  }
}

window.loadUsageStats = loadUsageStats;
refreshUsageButton?.addEventListener("click", loadUsageStats);
usageProviderFilter?.addEventListener("change", () => {
  const selectedProvider = usageProviderFilter.value;
  if (usageModelFilter?.value && !usageModelFilter.value.startsWith(`${selectedProvider}/`)) usageModelFilter.value = "";
  loadUsageStats();
});
usageModelFilter?.addEventListener("change", loadUsageStats);
usageFilterClear?.addEventListener("click", () => {
  if (usageProviderFilter) usageProviderFilter.value = "";
  if (usageModelFilter) usageModelFilter.value = "";
  loadUsageStats();
});
