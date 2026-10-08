// Machines: other computers a session's tools can run on, over SSH (see machines.ts on the agent). This file has the
// Settings tab that adds and checks them, and the choice made when a new session starts.
const machinesList = document.getElementById("machines-list");
const machineForm = document.getElementById("machine-form");
const machineFormResult = document.getElementById("machine-form-result");
const sessionTargetModal = document.getElementById("session-target-modal");
const sessionTargetList = document.getElementById("session-target-list");
const sessionTargetClose = document.getElementById("session-target-close");

let machines = [];
// The public key of the machine added most recently, for the Copy button under the form.
let addedKey = "";

// The line each machine's key is found under, shown so the owner knows what to paste where.
const AUTHORIZE_HINT = "On the machine, add this line to ~/.ssh/authorized_keys:";
const HOST_KEY_HINT = "Check that it matches the machine's own key. On the machine, run:";
const HOST_KEY_COMMAND = "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub";

function machineAddress(m) {
  return `${m.user ? `${escapeHtml(m.user)}@` : ""}${escapeHtml(m.host)}${m.port ? `:${m.port}` : ""}`;
}

function machineCard(m) {
  const status = m.trusted
    ? `<span class="provider-meta ok">${iconTag("check", 12)} Ready</span>`
    : `<span class="provider-meta">Confirm the host key to connect</span>`;
  const primary = m.trusted
    ? `<button type="button" class="btn-secondary icon-btn-text" data-act="test"><span class="btn-label">Test connection</span></button>`
    : `<button type="button" class="btn-primary icon-btn-text" data-act="scan"><span class="btn-label">Confirm host key</span></button>`;
  return `
    <article class="machine-card" data-id="${m.id}">
      <div class="machine-card-head">${iconTag("terminal", 16, "dim")}<strong>${escapeHtml(m.name)}</strong></div>
      <div class="machine-card-meta"><code>${machineAddress(m)}</code>${status}</div>
      <div class="machine-card-folder">${iconTag("folder", 13, "dim")}<code>${escapeHtml(m.folder)}</code></div>
      <div class="machine-card-actions">
        ${primary}
        <button type="button" class="btn-secondary icon-btn-text" data-act="key"><span class="btn-label">Show key</span></button>
        <button type="button" class="btn-secondary icon-btn-text" data-act="delete">${iconTag("trash-2", 15)}<span class="btn-label">Remove</span></button>
      </div>
      <div class="machine-card-panel" hidden></div>
    </article>`;
}

function renderMachines() {
  if (!machinesList) return;
  machinesList.innerHTML = machines.length
    ? machines.map(machineCard).join("")
    : `<p class="description">No machines yet. Add one below, and a session started on it runs its files and shell there.</p>`;
}

async function loadMachines() {
  if (!machinesList) return;
  try {
    const data = await sessionsApi("/api/machines");
    machines = data.machines;
    renderMachines();
  } catch (error) {
    machinesList.innerHTML = `<p class="description">Could not load machines: ${escapeHtml(error.message)}</p>`;
  }
  // The sidebar's machine labels come from the sessions list, so it is refreshed whenever a machine changes.
  window.loadSidebarSessions?.();
}

function cardPanel(card) {
  return card.querySelector(".machine-card-panel");
}

function showPanel(card, html) {
  const panel = cardPanel(card);
  panel.innerHTML = html;
  panel.hidden = false;
}

// ssh's refusal is the most common first failure: the key is not on the machine, or the user name is not the one
// it logs in as. Say so, since the raw ssh line does not.
function explain(message) {
  if (!/Permission denied/i.test(message)) return message;
  return `${message} The machine refused the key: check the user name, and that the public key is in that user's ~/.ssh/authorized_keys.`;
}

function errorPanel(card, error) {
  showPanel(card, `<p class="description">${escapeHtml(explain(error.message))}</p>`);
}

// chat.js owns the clipboard helper, which falls back to a textarea where the WebView refuses the async API.
async function copyToClipboard(text) {
  if (typeof window.copyText === "function") return window.copyText(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function scanHostKey(card, id) {
  const { fingerprints } = await sessionsApi(`/api/machines/${id}/scan`, "POST");
  // One line per key type the machine offers; trusting any one of them trusts that key.
  showPanel(card, `
    <p class="description">${HOST_KEY_HINT} <code>${HOST_KEY_COMMAND}</code></p>
    ${fingerprints.map(fp => `
      <div class="machine-fingerprint">
        <code class="machine-key">${escapeHtml(fp)}</code>
        <button type="button" class="btn-primary icon-btn-text" data-act="trust" data-fingerprint="${escapeHtml(fp)}"><span class="btn-label">It matches, trust it</span></button>
      </div>`).join("")}`);
}

async function trustHostKey(card, id, fingerprint) {
  await sessionsApi(`/api/machines/${id}/trust`, "POST", { fingerprint });
  await loadMachines();
}

async function testMachine(card, id) {
  const { platform } = await sessionsApi(`/api/machines/${id}/test`, "POST");
  const warnings = platform.warnings?.length ? ` ${platform.warnings.join(" ")}` : "";
  showPanel(card, `<p class="description">Connected: ${escapeHtml(platform.platform)} ${escapeHtml(platform.arch)}, home ${escapeHtml(platform.home)}.${escapeHtml(warnings)}</p>`);
}

function showKey(card, m) {
  showPanel(card, `
    <p class="description">${AUTHORIZE_HINT}</p>
    <code class="machine-key">${escapeHtml(m.publicKey)}</code>
    <div class="machine-card-actions">
      <button type="button" class="btn-secondary icon-btn-text" data-act="copy-key"><span class="btn-label">Copy key</span></button>
    </div>`);
}

machinesList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const card = button.closest(".machine-card");
  const id = Number(card.dataset.id);
  const m = machines.find(row => row.id === id);
  const act = button.dataset.act;
  button.disabled = true;
  try {
    if (act === "scan") await scanHostKey(card, id);
    else if (act === "trust") await trustHostKey(card, id, button.dataset.fingerprint);
    else if (act === "test") await testMachine(card, id);
    else if (act === "key") showKey(card, m);
    else if (act === "copy-key") {
      const label = button.querySelector(".btn-label");
      label.textContent = (await copyToClipboard(m.publicKey)) ? "Copied" : "Could not copy";
    } else if (act === "delete") {
      if (!confirm(`Remove ${m.name}? Its files on the machine are left alone.`)) return;
      await sessionsApi(`/api/machines/${id}/delete`, "POST");
      await loadMachines();
    }
  } catch (error) {
    errorPanel(card, error);
  } finally {
    button.disabled = false;
  }
});

machineFormResult?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-act=copy-added]");
  if (!button || !addedKey) return;
  const label = button.querySelector(".btn-label");
  label.textContent = (await copyToClipboard(addedKey)) ? "Copied" : "Could not copy";
});

machineForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = machineForm.querySelector("[type=submit]");
  const fields = Object.fromEntries(new FormData(machineForm));
  submit.disabled = true;
  try {
    const { machine } = await sessionsApi("/api/machines", "POST", fields);
    machineForm.reset();
    addedKey = machine.publicKey;
    machineFormResult.hidden = false;
    machineFormResult.innerHTML = `
      <p class="description">Added ${escapeHtml(machine.name)}. On the Mac, add this line to ~/.ssh/authorized_keys for ${escapeHtml(machine.user)}:</p>
      <code class="machine-key">${escapeHtml(machine.publicKey)}</code>
      <div class="machine-card-actions">
        <button type="button" class="btn-secondary icon-btn-text" data-act="copy-added"><span class="btn-label">Copy key</span></button>
      </div>
      <p class="description">Then confirm the host key on ${escapeHtml(machine.name)}'s card below.</p>`;
    await loadMachines();
  } catch (error) {
    machineFormResult.hidden = false;
    machineFormResult.innerHTML = `<p class="description">${escapeHtml(error.message)}</p>`;
  } finally {
    submit.disabled = false;
  }
});

window.loadMachinesTab = loadMachines;

// Where a new session runs. Resolves with a machine id, with null for this phone, or with undefined when cancelled.
// Machines that have not had their host key confirmed are listed but cannot be picked yet.
window.chooseSessionMachine = (choices) => new Promise(resolve => {
  const rows = [
    `<button type="button" class="sheet-row" data-machine-id="">${iconTag("cpu", 16)}<span>This phone</span></button>`,
    ...choices.map(m => `
      <button type="button" class="sheet-row" data-machine-id="${m.id}"${m.trusted ? "" : " disabled"}>
        ${iconTag("terminal", 16)}
        <span>${escapeHtml(m.name)}</span>
        <span class="sheet-row-value">${m.trusted ? "" : "Confirm the host key first"}</span>
      </button>`),
  ];
  sessionTargetList.innerHTML = rows.join("");
  sessionTargetModal.hidden = false;

  const finish = (value) => {
    sessionTargetModal.hidden = true;
    sessionTargetList.removeEventListener("click", onPick);
    sessionTargetClose.removeEventListener("click", onCancel);
    sessionTargetModal.removeEventListener("click", onBackdrop);
    resolve(value);
  };
  const onPick = (event) => {
    const row = event.target.closest("[data-machine-id]");
    if (!row || row.disabled) return;
    finish(row.dataset.machineId === "" ? null : Number(row.dataset.machineId));
  };
  const onCancel = () => finish(undefined);
  const onBackdrop = (event) => {
    if (event.target === sessionTargetModal) finish(undefined);
  };
  sessionTargetList.addEventListener("click", onPick);
  sessionTargetClose.addEventListener("click", onCancel);
  sessionTargetModal.addEventListener("click", onBackdrop);
});
