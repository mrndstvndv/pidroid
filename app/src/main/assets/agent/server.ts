import { Database } from "bun:sqlite";
import { join, dirname, resolve, extname, sep, basename } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, cpSync, rmSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineEntry, defineExtension, defineTool, Harness, hook, section, ToolTask, type Conversation } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import { conversationDescendants, purgeConversations } from "./purge.ts";
import {
  buildTranscript,
  countMessages,
  transcriptFileName,
  transcriptToJson,
  transcriptToMarkdown,
  type TranscriptMessage,
  type TranscriptMeta,
} from "./transcript.ts";
import WebTools from "./web-tools.ts";
import { commandCodeProvider, commandCodeUsage, commandCodeUsageData } from "./providers/commandcode.ts";
import { opencodeProvider, normalizeOpencodeCatalog } from "./providers/opencode.ts";
import { GITHUB_COPILOT_PROVIDER_ID, withCopilotOAuth } from "./providers/github-copilot.ts";
import { FileCredentialStore, LoginManager } from "./auth.ts";
import { bridgeAvailable, bridgeCall } from "./bridge.ts";
import { Changes } from "./changes.ts";
import { showTool } from "./artifacts.ts";
import { assemble, foldContext, withoutFolded } from "./diffrows.ts";
import { fenceLanguage, highlight, highlightPath, languageFor, MAX_INTERACTIVE_CHARS, warm as warmHighlighter } from "./highlight.ts";
import { ExtensionLoader } from "./extensions.ts";
import { DEFAULT_TITLE, Sessions, type SessionRow } from "./sessions.ts";
import { discoverSkills, renderSkillsPrompt, SKILLS_DIR } from "./skills.ts";
import { ChatViewBuilder, clampLevel, liveDelta, renderMarkdown, supportedLevels, MODEL_CHANGE_ENTRY_KIND, THINKING_CHANGE_ENTRY_KIND, type ChatView } from "./chatview.ts";
import { Timings } from "./timings.ts";
import { SKIP_DIRS, SKIP_FILES, SKIP_SUFFIXES, writeBundle } from "./bundles.ts";

const PORT = Number(process.env.PORT) || 8765;
/** The app itself: the server, the UI and the git checkpoint journal. */
const APP_DIR = process.cwd();
const WWW_DIR = join(APP_DIR, "www");
const DB_PATH = join(APP_DIR, "pidroid.sqlite");
const ModelChangeEntry = defineEntry(MODEL_CHANGE_ENTRY_KIND);
const ThinkingChangeEntry = defineEntry(THINKING_CHANGE_ENTRY_KIND);

/**
 * One directory per session, so sessions stop fighting over the same files. It is a sibling of the
 * app directory on purpose: changes.ts checkpoints the whole app tree after every turn, and session
 * scratch work has no business in that journal (or in the Changes tab, or in a saved bundle). The
 * cost is that the harness code is no longer the working directory, so the agent reaches it by
 * absolute path ($PIDROID_APP_DIR).
 */
const WORKSPACES_DIR = join(dirname(APP_DIR), "workspaces");
const UPLOADS_DIR = join(APP_DIR, "uploads");
const MAX_AGENT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_IMAGES = 8;
const MAX_AGENT_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
const workspaceDir = (conversationId: number) => join(WORKSPACES_DIR, String(conversationId));

/**
 * A branch inherits the parent's transcript, and that transcript tends to name files the parent made in
 * its own workspace, so the branch starts with a copy of them rather than an empty directory. The copy
 * is a snapshot of the directory as it is when you branch: the parent's later writes do not appear, and
 * the two never share a file.
 *
 * It is capped because these directories are scratch, not curated — one session on this phone holds
 * 300 MB of downloads, and silently duplicating that per branch would fill the device. Over the cap
 * nothing is copied: half a workspace would be worse than none, since the missing half is invisible.
 */
const FORK_COPY_LIMIT_BYTES = 64 * 1024 * 1024;

/** Total bytes under a directory, or Infinity if it cannot be walked. */
function treeSize(dir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) walk(child);
      else if (item.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          return; // vanished mid-walk; it is scratch, so losing it is not worth failing over
        }
      }
    }
  };
  try {
    walk(dir);
    return total;
  } catch {
    return Infinity;
  }
}

type AgentInputContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
type AgentImageAttachment = { path?: string; label?: string; name?: string };

/** Resolve composer image references and legacy upload paths into ordered multimodal blocks. */
function agentInputContent(text: string, attachments: AgentImageAttachment[] = []): { content: AgentInputContent; error?: string } {
  let uploadRoot: string;
  try {
    uploadRoot = realpathSync(UPLOADS_DIR);
  } catch {
    return attachments.length ? { content: text, error: "The upload directory is unavailable; reattach the image and try again." } : { content: text };
  }

  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const uploadPrefix = resolve(UPLOADS_DIR) + sep;

  const addImage = (candidate: string, requestedLabel?: string, explicit = false): string | undefined => {
    try {
      if (!candidate.startsWith(uploadPrefix)) return explicit ? "Invalid image attachment path." : undefined;
      const file = realpathSync(candidate);
      if (!file.startsWith(uploadRoot + sep)) return explicit ? "Image attachments must be inside the app uploads directory." : undefined;
      if (seen.has(file)) return undefined;
      const stat = statSync(file);
      if (!stat.isFile()) return explicit ? "Only supported image files can be attached this way." : undefined;
      if (stat.size > MAX_AGENT_IMAGE_BYTES) return `Image attachments must be 8 MB or smaller (${candidate}).`;
      if (images.length >= MAX_AGENT_IMAGES) return `Attach no more than ${MAX_AGENT_IMAGES} images in one message.`;
      if (totalBytes + stat.size > MAX_AGENT_TOTAL_IMAGE_BYTES) return "Attached images must total 32 MB or less.";
      const bytes = readFileSync(file);
      const mimeType = imageMimeFromHeader(bytes.subarray(0, 12)) ?? IMAGE_MIME_BY_EXTENSION[extname(file).toLowerCase()];
      if (!mimeType) return explicit ? "Only supported image files can be attached this way." : undefined;
      images.push({ type: "image", mimeType, data: bytes.toString("base64") });
      labels.push(requestedLabel && /^Image #\d+$/.test(requestedLabel) ? requestedLabel : `Image #${images.length}`);
      seen.add(file);
      totalBytes += stat.size;
      return undefined;
    } catch {
      return explicit ? `Could not read image attachment: ${candidate}` : undefined;
    }
  };

  for (const attachment of attachments) {
    if (!attachment || typeof attachment.path !== "string") return { content: text, error: "Invalid image attachment." };
    const error = addImage(attachment.path.trim(), attachment.label, true);
    if (error) return { content: text, error };
  }

  // Keep accepting absolute upload paths inserted by older clients or pasted into the composer.
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith(uploadPrefix)) continue;
    const error = addImage(candidate);
    if (error) return { content: text, error };
  }

  if (!images.length) return { content: text };
  const imageNote = `Attached images are provided in this order: ${labels.map(label => `[${label}]`).join(", ")}. Refer to each image by its label.`;
  const prompt = text ? `${text}\n\n${imageNote}` : imageNote;
  return { content: [{ type: "text", text: prompt }, ...images] };
}

/* ---------- file tree (Files tab) ----------
   The Files tab shows what a bundle archives, so its skip lists are the ones bundles.ts uses
   (imported, not copied): the tab, the Export bundle button and the save_bundle tool therefore
   cannot drift apart -- a file the tab promises is a file the tarball carries. */
const TREE_SKIP_DIRS = SKIP_DIRS;
const TREE_SKIP_FILES = SKIP_FILES;
const TREE_SKIP_SUFFIXES = SKIP_SUFFIXES;

/** Largest file the tree preview will render. Above this the tab shows the size and nothing else. */
const MAX_READ_BYTES = 512 * 1024;

/** Above this the preview shows plain text. Tokenising costs roughly a second per 100 KB on this
 *  phone, and the markup is ~10x the file size on the wire -- past this point that stops being a
 *  good trade for a file someone is only skimming. */
const MAX_HIGHLIGHT_BYTES = 200 * 1024;

function sha256Hex(buf: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

// Initialize SQLite database
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agent_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timings (
    session INTEGER NOT NULL,
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (session, key)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS token_usage_events (
    event_key TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_total REAL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS token_usage_by_session_time
    ON token_usage_events (session_id, captured_at);
  CREATE INDEX IF NOT EXISTS token_usage_by_time
    ON token_usage_events (captured_at);
`);

console.log(`[pidroid] Agent runtime initialized. SQLite DB at: ${DB_PATH}`);

// Active WebSocket clients (for live agent events and UI hot-reloading)
const clients = new Set<any>();

function broadcast(event: string, payload: any) {
  // No browser can receive this while the app is backgrounded, so don't stringify snapshots just
  // to discard them. The next WebSocket connection gets a fresh complete state in `open()`.
  if (!clients.size) return;
  const message = JSON.stringify({ event, payload, timestamp: Date.now() });
  for (const ws of clients) {
    try {
      ws.send(message);
    } catch {
      clients.delete(ws);
    }
  }
}

/**
 * Clients whose page has told us it is hidden (screen off, or another app in front). A connection
 * that has not said anything yet counts as visible: the page reports its state the moment it opens,
 * and treating that first instant as "away" would fire a notification at someone watching the app
 * come up.
 */
const hiddenClients = new Set<any>();

/** Whether a browser is on screen right now. A run that ends unseen is what the notification is for. */
function watchingUi(): boolean {
  for (const ws of clients) if (!hiddenClients.has(ws)) return true;
  return false;
}

// Every agent turn is bracketed by git checkpoints so changes can be inspected and undone.
const changes = new Changes(process.cwd());
// Scanning the whole app tree for the startup checkpoint is slow on a phone, and nothing below needs
// it: every git operation goes through Changes' serial queue, so the first turn's snapshot simply
// waits behind it. Don't hold the server back for it.
changes.init().catch((err) => console.warn("[pidroid] startup checkpoint failed:", err));

// --- pi-durable agent ---------------------------------------------------
const context = BACKGROUND_CONTEXT;
const AGENT_DB_PATH = join(process.cwd(), "pidroid-agent.sqlite");

/**
 * pi-ai's default models store is in-memory, so a refreshed catalog dies with
 * the process and every boot falls back to the provider's bundled snapshot.
 * That is how Command Code kept losing models the API had already published
 * (the snapshot is a snapshot: DeepSeek V4.1 Flash was missing from it).
 * Persisting the published catalogs makes a refresh stick across restarts.
 */
const MODELS_STORE_PATH = join(process.cwd(), "pidroid-models.json");

/**
 * Repairs a persisted catalog in place before it is handed back to the registry: the stored copy is
 * the one that reaches the model, so a catalog written by an older build would otherwise keep
 * failing requests. See providers/opencode.ts for the one repair we know we need.
 */
function normalizeCatalog(providerId: string, models: any): any {
  return providerId === "opencode" ? normalizeOpencodeCatalog(models) : models;
}

class FileModelsStore {
  private entries = new Map<string, unknown>();

  constructor(private path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof raw === "object" && raw !== null) {
        for (const [providerId, entry] of Object.entries(raw)) this.entries.set(providerId, entry);
      }
    } catch {
      // Missing or corrupt: start empty and let the next refresh rewrite it.
    }
  }

  async read(providerId: string, options?: { signal?: AbortSignal }): Promise<any> {
    options?.signal?.throwIfAborted();
    const entry = this.entries.get(providerId);
    if (entry === undefined) return undefined;
    const copy = structuredClone(entry) as any;
    if (Array.isArray(copy?.models)) copy.models = normalizeCatalog(providerId, copy.models);
    return copy;
  }

  async write(providerId: string, entry: unknown, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    this.entries.set(providerId, structuredClone(entry));
    this.flush();
  }

  async delete(providerId: string, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    this.entries.delete(providerId);
    this.flush();
  }

  /** Write-then-rename so a kill mid-write cannot leave a truncated catalog. */
  private flush() {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)));
      renameSync(tmp, this.path);
    } catch {}
  }
}

// Every pi-ai built-in provider, plus the ported OpenCode Zen free tier and
// Command Code providers (same ids replace the built-in versions).
const credentials = new FileCredentialStore(join(process.cwd(), "auth.json"));
const models = builtinModels({ credentials, modelsStore: new FileModelsStore(MODELS_STORE_PATH) });
models.setProvider(opencodeProvider());
models.setProvider(commandCodeProvider());

// Same id again: the bundle's github-copilot login points at an OAuth module that
// was never packaged ("./github-copilot.js"), so give it a working sign-in instead.
// The tap reports which models this Copilot plan actually serves (learned from
// Copilot's own error) so the picker stops offering the ones it will refuse.
const copilotProvider = models.getProvider(GITHUB_COPILOT_PROVIDER_ID);
if (copilotProvider) {
  models.setProvider(
    withCopilotOAuth(copilotProvider, async (availableModelIds) => {
      await credentials.modify(GITHUB_COPILOT_PROVIDER_ID, async (current) =>
        current?.type === "oauth" ? { ...current, availableModelIds } : current,
      );
      broadcast("providers_changed", {});
    }),
  );
}

// Catalogs self-heal at boot; without this the picker only ever shows whatever
// the last manual "Refresh catalogs" produced (and nothing, on a fresh install).
void models
  .refresh({ providers: ["opencode", "commandcode"], signal: AbortSignal.timeout(30_000) })
  .then(() => broadcast("providers_changed", {}))
  .catch(() => {});

const logins = new LoginManager(models, credentials, broadcast);

/**
 * Providers that can report account usage for the UI, keyed by provider id. Each entry gets
 * the API key from the provider's own auth resolution, so a stored credential, an env var,
 * and the CLI's own auth file all behave the same way.
 */
const usageSources: Record<string, (apiKey: string, signal: AbortSignal) => Promise<unknown>> = {
  commandcode: commandCodeUsageData,
};

/** The key a provider would send, resolved through its own api-key auth flow. */
async function providerApiKey(providerId: string): Promise<string | undefined> {
  const apiKeyAuth = models.getProvider(providerId)?.auth?.apiKey;
  if (!apiKeyAuth) return undefined;
  const credential = await credentials.read(providerId).catch(() => undefined);
  const resolved = await apiKeyAuth
    .resolve({ credential } as Parameters<typeof apiKeyAuth.resolve>[0])
    .catch(() => undefined);
  return resolved?.auth?.apiKey;
}

/**
 * Android kills an app that spawns too many child processes (the "phantom process" limit), which takes the whole agent
 * down. Probing loops over /proc, whole-device finds and greps of the generated bundle are the usual culprits, and
 * none of them help with the task, so they are refused with a pointer to the right place.
 */
function blockedBashReason(command: string): string | undefined {
  if (/\/proc\/(\[|\*|\$|\{)/.test(command)) return "Looping over /proc spawns hundreds of processes and gets this app killed by Android. Don't enumerate processes.";
  if (/\bfind\s+\/(\s|$|data\s|proc|sys|system|vendor|apex)/.test(command)) return "Whole-device find is refused (slow, and it can get this app killed). Search inside the workspace only.";
  if (/\b(server\.js|vendor\/|fallback\/)/.test(command)) return `${APP_DIR}/vendor and ${APP_DIR}/fallback are generated minified bundles; reading them is useless. Read server.ts, auth.ts, changes.ts, chatview.ts, sessions.ts, extensions.ts and providers/ in ${APP_DIR} instead.`;
  return undefined;
}

/** Exit code the Android app treats as "restart me now" (anything else counts as a crash). */
const PLANNED_EXIT_CODE = 75;

/** Exit so the app relaunches this server; the flag tells the next boot that unfinished runs should resume, not abort. */
function scheduleRestart(delayMs: number) {
  setState("planned_restart", String(Date.now()));
  console.log(`[pidroid] planned restart in ${delayMs}ms`);
  setTimeout(() => process.exit(PLANNED_EXIT_CODE), delayMs);
}

// A user-requested stop exits Bun without the planned-restart code. The Android host currently
// treats other exit codes as crashes; a host-level stop signal would be needed to avoid that.
let stopScheduled = false;
function scheduleStop(delayMs: number) {
  if (stopScheduled) return;
  stopScheduled = true;
  setState("planned_stop", "1");
  console.log(`[pidroid] server stop requested; exiting in about ${delayMs}ms`);
  setTimeout(() => {
    const hardExit = setTimeout(() => process.exit(0), 2500);
    const aborts = sessions.list().map((row) =>
      handleFor(row).then((conversation) => conversation.abort(context)).catch((err) => {
        console.warn(`[pidroid] abort before server stop (session ${row.id}):`, err);
      }),
    );
    void Promise.all(aborts).finally(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  }, delayMs);
}

/** Bundle server.ts into a temp file: catches syntax errors and unresolved imports before they take the server down. */
async function preflight(): Promise<string | undefined> {
  const out = join(tmpdir(), `pidroid-preflight-${Date.now()}.js`);
  try {
    const proc = Bun.spawn([process.execPath, "build", "server.ts", "--target=bun", `--outfile=${out}`], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return code === 0 ? undefined : `${stderr}${stdout}`.trim().slice(0, 3000) || `bun build exited with code ${code}`;
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * Reloading the page mid-run throws away what the user is looking at (streaming text, open sections), so changes to
 * HTML/JS don't reload it on their own while the agent works. CSS swaps in place and is applied at once. The agent
 * calls reload_ui when a batch of edits is done; if it forgets, the page reloads once everything is idle.
 */
let pendingReload = false;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

function requestUiReload(filename: string | null | undefined) {
  if (filename?.endsWith(".css")) {
    broadcast("ui_reload", { filename });
    return;
  }
  pendingReload = true;
  checkIdleThenReload(600);
}

function checkIdleThenReload(delayMs: number) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    reloadTimer = undefined;
    if (!pendingReload) return;
    const busy = await busySessions().catch(() => new Set<number>());
    if (busy.size > 0) {
      checkIdleThenReload(2000); // still working: look again shortly
    } else {
      pendingReload = false;
      broadcast("ui_reload", { filename: "index.html" });
    }
  }, delayMs);
}

const reloadUiTool = defineTool({
  name: "reload_ui",
  description:
    "Reload the web UI on the user's screen so your edits to www/ (HTML or JS) take effect. Editing those files does NOT reload the page by itself while you are working, " +
    "so the user's screen stays stable; call this once, after you have finished a batch of UI edits. CSS-only changes apply immediately without it.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    pendingReload = false;
    if (reloadTimer) clearTimeout(reloadTimer);
    setTimeout(() => broadcast("ui_reload", { filename: "index.html" }), 800); // let this tool result commit first
    api.output("The UI will reload in a moment.");
    return {};
  },
});

const reloadExtensionsTool = defineTool({
  name: "reload_extensions",
  description:
    "Re-import every file in extensions/ and hot-swap the extensions (tools, prompt sections, hooks) without restarting. " +
    "Running work finishes on the old code; the next tool call or request uses the new one. Reports import errors per file.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    const result = await loader.reload();
    const lines = [
      ...result.loaded.map((l) => `loaded ${l}`),
      ...result.removed.map((r) => `removed ${r}`),
      ...Object.entries(result.errors).map(([file, error]) => `ERROR ${file}: ${error}`),
    ];
    api.output(lines.join("\n") || "no extension files");
    return {};
  },
});

const restartServerTool = defineTool({
  name: "restart_server",
  description:
    "Restart the agent server so edits to server.ts, auth.ts, changes.ts, chatview.ts, sessions.ts, extensions.ts, web-tools.ts or providers/ take effect. " +
    "It first checks that server.ts still builds and refuses to restart if not. Every session continues afterwards; unfinished runs resume. " +
    "If the new server fails to start 3 times the app falls back to a known-good safe-mode server so the user can undo the edit. " +
    "For tools, prompt sections and hooks prefer reload_extensions, which needs no restart.",
  parameters: Type.Object({ reason: Type.Optional(Type.String({ description: "Why the restart is needed" })) }),
  execute: async (_args, api) => {
    const problem = await preflight();
    if (problem) throw new Error(`Not restarting: server.ts does not build.\n${problem}`);
    // scheduleRestart arms a timer that exits this process, so this run stops right here and the app's
    // next launch picks it up again (harness.resume). Nothing after this tool call runs in this process,
    // which is why the message says so instead of the reassuring "your session continues".
    api.output(
      "Preflight passed, so the restart is committed and cannot be called off. " +
        "This process exits in about a second; the app relaunches the server, which resumes this run from here. " +
        "Your file edits are already on disk, so nothing has to be redone. " +
        "Make this the last tool call of the turn: any command run after it dies with the old process. " +
        "Finish anything left by writing files, not by running them.",
    );
    scheduleRestart(1500);
    return {};
  },
});

const READ_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const READ_IMAGE_MAX_INPUT_BYTES = 32 * 1024 * 1024;

function imageMimeFromHeader(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return undefined;
}

const textReadTool = createReadTool();
const imageAwareReadTool = defineTool({
  name: "read",
  description: `Read text files and images (jpg, png, gif, webp, bmp). Images are attached to the conversation so vision-capable models can inspect them. Text output is truncated to 2000 lines or 50KB; use offset/limit for large files.`,
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  }),
  async execute(args, api, context) {
    const env = api.env;
    const resolved = await env.absolutePath(args.path, context);
    if (!resolved.ok) throw resolved.error;
    const opened = await env.openBinaryReader(resolved.value, undefined, context);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    try {
      const infoResult = await reader.info(context);
      if (!infoResult.ok) throw infoResult.error;
      const info = infoResult.value;
      const prefixResult = await reader.read(0, Math.min(info.size, 12), context);
      if (!prefixResult.ok) throw prefixResult.error;
      const mimeType = imageMimeFromHeader(prefixResult.value);
      if (!mimeType) return await textReadTool.execute(args, api, context);

      if (info.size > READ_IMAGE_MAX_INPUT_BYTES) {
        return { content: [{ type: "text", text: `Read image file [${mimeType}]\nImage is too large to process safely (${info.size} bytes; maximum ${READ_IMAGE_MAX_INPUT_BYTES}).` }] };
      }
      const imageResult = await reader.read(0, info.size, context);
      if (!imageResult.ok) throw imageResult.error;
      const original = Buffer.from(imageResult.value);
      const activeAgent = await api.agent(context);
      const modelRef = activeAgent.model;
      const model = modelRef ? models.getModel(modelRef.provider, modelRef.modelId) : undefined;
      if (model && !model.input.includes("image")) {
        return { content: [{ type: "text", text: `Read image file [${mimeType}]\n[Current model does not support images. The image is omitted from this request.]` }] };
      }

      let imageBytes = original;
      let outputMimeType = mimeType;
      let resizeNote = "";
      if (original.length > READ_IMAGE_MAX_BYTES) {
        try {
          const maxDimension = 2048;
          const image = new Bun.Image(original, { maxPixels: 40_000_000 });
          const metadata = await image.metadata();
          imageBytes = Buffer.from(await image.resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).bytes());
          outputMimeType = "image/jpeg";
          resizeNote = `\nImage resized from ${metadata.width}×${metadata.height} to fit the ${READ_IMAGE_MAX_BYTES / (1024 * 1024)} MB attachment limit.`;
          if (imageBytes.length > READ_IMAGE_MAX_BYTES) {
            return { content: [{ type: "text", text: `Read image file [${mimeType}]\nImage is still too large after resizing (${imageBytes.length} bytes); it was omitted.` }] };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `Read image file [${mimeType}]\nImage could not be processed and was omitted: ${message}` }] };
        }
      }
      return {
        content: [
          { type: "text", text: `Read image file [${outputMimeType}]${resizeNote}` },
          { type: "image", data: imageBytes.toString("base64"), mimeType: outputMimeType },
        ],
      };
    } finally {
      await reader.close(context);
    }
  },
});

const ImageAwareCodingTools = defineExtension({
  ...CodingTools,
  tools: CodingTools.tools.map((tool) => tool.name === "read" ? imageAwareReadTool : tool),
});

const SelfModify = defineExtension({
  name: "pidroid",
  tools: [reloadUiTool, reloadExtensionsTool, restartServerTool, showTool],
  sections: [
    section(
      "pidroid",
      // `input.conversationId` is passed by the runtime (pi-durable's renderSections),
      // so the workspace path below is the real one for this conversation rather than
      // a placeholder the reader has to guess at. workspaceDir() is the same helper
      // used to create the directory, so the two cannot drift apart.
      (input) =>
        "You are the agent embedded in the Pidroid Android app, running on Bun inside the app's own process sandbox. " +
        `Your working directory is this session's own workspace (${workspaceDir(Number(input.conversationId))}, also $PIDROID_WORKSPACE): scratch files, scripts and experiments belong there and are yours alone. ` +
        `It is NOT version controlled: nothing in it is checkpointed, so nothing in it can be undone -- if the user wants to keep something, copy it into the app tree (below). ` +
        `The app itself lives at ${APP_DIR} (also $PIDROID_APP_DIR), and you can change it -- every path below is relative to it: ` +
        "www/ is the web UI (index.html, style.css, app.js, chat.js, sessions.js, providers.js, changes.js); CSS edits apply instantly, but HTML/JS edits only show after you call reload_ui (call it once when a batch of UI edits is finished, not after every file). " +
        "extensions/*.ts are hot-swappable pi-durable extensions (extensions/save-bundle.ts is a worked example): add tools, prompt sections and hooks there, then call reload_extensions. No restart is needed. " +
        `Shared Agent Skills are stored outside the app source at ${SKILLS_DIR} (also $PIDROID_SKILLS), one directory per skill with a SKILL.md file; they are shared across sessions and survive app code updates. ` +
        "server.ts, auth.ts, artifacts.ts, changes.ts, chatview.ts, sessions.ts, extensions.ts, web-tools.ts and providers/ are the server; after editing them call restart_server (it builds first and refuses if the build fails; all sessions continue afterwards). " +
        "vendor/ holds prebuilt dependencies and is not editable; only the packages mapped in tsconfig.json can be imported. " +
        `Files the user attaches from the phone are saved under ${UPLOADS_DIR} (also $PIDROID_UPLOADS). Composer image attachments are labeled [Image #N] and sent as image inputs in that order; use those labels to distinguish multiple images. The read tool also supports image files and sends them as image input to vision-capable models. If a file path is shown in the message, it is absolute and should be used as given. ` +
        "The UI is black (AMOLED) themed; keep it that way. " +
        "Every turn is checkpointed to git, so the user can undo your changes to the app (the workspace is not). If the server fails to start repeatedly the app falls back to a safe-mode server, so a broken edit can be undone from the Changes tab. " +
        "The Android shell around the web view (Kotlin) is not part of your sandbox and cannot be edited from here; if a feature needs it, say so instead of searching the device. " +
        "The shell userland on this phone is Android's toybox/mksh, not GNU: expect missing or different flags (cat -A is unsupported; use cat -etv, od -c, or read the file with the read tool; prefer small portable commands). " +
        "grep, egrep and fgrep are the exception: they are GNU grep 3.12, bundled in the APK and first on PATH ahead of toybox. Use it through the bash tool like any other command -- the whole GNU flag set works (-P, -o, -w, -v, -m, -A/-B/-C, --include=, --exclude=, --exclude-dir=, --group-separator=), with GNU exit codes. Two things to know: GNU grep has no --stats option (it never did), and -r descends into .git, node_modules, .tmp and sqlite files, so pass --exclude-dir=.git --exclude-dir=node_modules and -I when you walk a source tree. " +
        "On PATH: bun (the full CLI: bun run / test / build / install / add), bunx, ssh, ssh-keygen and GNU grep. Use bun to try out your own changes: run scripts and `bun test` against extensions in isolation, and `bun build server.ts --target=bun --outfile=/tmp/x.js` to check that the server still builds. " +
        "Never `bun run server.ts` (a second server would fight this one for the port and the databases). " +
        "A package's own CLI cannot be started through bunx or node_modules/.bin on Android (those scripts start with #!/usr/bin/env, which does not exist here): after `bun add <pkg>` run its script directly, e.g. `bun node_modules/<pkg>/bin/<cli>.js`. " +
        "Keep shell commands small and targeted; never loop over /proc or search the whole filesystem.",
      { tag: false },
    ),
    section("skills", renderSkillsPrompt),
  ],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => {
        if (call.name !== "bash") return undefined;
        const command = String((call.arguments as { command?: unknown })?.command ?? "");
        const reason = blockedBashReason(command);
        return reason ? { block: reason } : undefined;
      },
    }),
  ],
});

const registry = createRegistry();
registry.install(ImageAwareCodingTools);
registry.install(SelfModify);
registry.install(WebTools);
const loader = new ExtensionLoader(registry, join(APP_DIR, "extensions"), file => !disabledExtensions().has(file));
{
  const loaded = await loader.reload();
  for (const line of loaded.loaded) console.log(`[pidroid] extension ${line}`);
  for (const [file, error] of Object.entries(loaded.errors)) console.warn(`[pidroid] extension ${file} failed: ${error}`);
}

const harness = await Harness.open(
  await openNodeSqliteStorage(AGENT_DB_PATH),
  {
    models,
    registry,
    env: ({ conversationId, cwd }) => {
      // Each conversation runs in its own workspace; a conversation without a stored cwd (a session
      // created before workspaces existed, and only for the turn or two before the migration runs)
      // still gets a directory of its own rather than sharing the app tree.
      const dir = cwd ? join(cwd) : workspaceDir(Number(conversationId));
      mkdirSync(dir, { recursive: true });
      // Hand the shell a valid $PWD. Without it bash falls back to its own getcwd(), which walks up through parent
      // directories; the app sandbox can't list /data/user/0 or /data, so every command printed
      // "shell-init: error retrieving current directory: getcwd: cannot access parent directories".
      return new NodeExecutionEnv({
        cwd: dir,
        shellEnv: { PWD: dir, PIDROID_WORKSPACE: dir, PIDROID_APP_DIR: APP_DIR, PIDROID_UPLOADS: UPLOADS_DIR, PIDROID_SKILLS: SKILLS_DIR },
      });
    },
    // A hung provider request must fail (and retry) instead of blocking the queue forever.
    settings: { stream: { timeoutMs: 180_000 }, retry: { maxRetries: 2 } },
  },
  context,
);

function getState(key: string): string | undefined {
  return (db.query("SELECT value FROM agent_state WHERE key = ?").get(key) as { value: string } | null)?.value;
}
function setState(key: string, value: string) {
  db.query("INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// Which extension files the user has switched off in Settings. Read fresh on every reload rather than
// captured once, so a toggle applies to the next hot-swap without a restart.
const DISABLED_EXTENSIONS_KEY = "extensions.disabled";
function disabledExtensions(): Set<string> {
  try {
    const parsed = JSON.parse(getState(DISABLED_EXTENSIONS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : []);
  } catch {
    return new Set();
  }
}
function setExtensionEnabled(file: string, enabled: boolean) {
  const disabled = disabledExtensions();
  if (enabled) disabled.delete(file);
  else disabled.add(file);
  setState(DISABLED_EXTENSIONS_KEY, JSON.stringify([...disabled]));
}

// --- Sessions: any number of pi-durable conversations, one shown at a time ---------------------------------
const sessions = new Sessions(db);
const handles = new Map<number, Conversation>();
let current!: SessionRow;
let root!: Conversation; // the displayed session's conversation; handlers capture it at request start

/**
 * The model new sessions start with. An explicit choice (the chooser's star, or the "model"
 * state) wins; otherwise this fallback. It is deliberately not "whatever provider happens to
 * have a key": a default that changes because you signed in somewhere else is not a default.
 */
const FALLBACK_MODEL = { provider: "opencode", modelId: "space-bunny-free" } as const;

function defaultModel(): { provider: string; modelId: string } {
  const saved = getState("model");
  if (saved) {
    const [provider, ...rest] = saved.split("/");
    const modelId = rest.join("/");
    if (models.getModel(provider, modelId)) return { provider, modelId };
  }
  return { ...FALLBACK_MODEL };
}

/** The displayed session's model, falling back to the default. */
function pickDefaultModel(): { provider: string; modelId: string } {
  if (current?.model) {
    const [provider, ...rest] = current.model.split("/");
    const modelId = rest.join("/");
    if (models.getModel(provider, modelId)) return { provider, modelId };
  }
  return defaultModel();
}

function titleModelPreference(): { key: string; provider: string; modelId: string } | undefined {
  const key = getState("title_model")?.trim();
  if (!key) return undefined;
  const [provider, ...rest] = key.split("/");
  const modelId = rest.join("/");
  return provider && modelId && models.getModel(provider, modelId) ? { key, provider, modelId } : undefined;
}

/** Preferred thinking effort for the displayed session, clamped to what its model supports. */
function thinkingInfo() {
  const agent = pickDefaultModel();
  const levels = supportedLevels(models.getModel(agent.provider, agent.modelId));
  const preferred = current?.thinking ?? getState("thinking") ?? "medium";
  return { current: clampLevel(preferred, levels), preferred, levels };
}

async function applyThinking() {
  await root.configure({ thinkingLevel: thinkingInfo().current as any }, context);
}

async function handleFor(row: SessionRow): Promise<Conversation> {
  let conv = handles.get(row.conversationId);
  if (!conv) {
    conv = await harness.conversation(row.conversationId as any, context);
    if (!conv) throw new Error(`Conversation ${row.conversationId} is missing from storage`);
    handles.set(row.conversationId, conv);
  }
  return conv;
}

async function createSession(): Promise<SessionRow> {
  const model = pickDefaultModel();
  const thinking = thinkingInfo().current;
  const conv = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model, thinkingLevel: thinking as any } },
    context,
  );
  const row = sessions.create(Number(conv.id), DEFAULT_TITLE, `${model.provider}/${model.modelId}`, thinking);
  handles.set(row.conversationId, conv);
  await pointAtWorkspace(row);
  return row;
}

/** Give a session its own working directory (created on demand) and make the agent run there. */
async function pointAtWorkspace(row: SessionRow): Promise<string> {
  const dir = workspaceDir(row.conversationId);
  mkdirSync(dir, { recursive: true });
  const conv = await handleFor(row);
  await conv.configure({ cwd: dir } as any, context);
  return dir;
}

/**
 * Branch a new session off an existing one at a committed entry. pi-durable records the parent and the
 * entry on the child's conversation and copies its documents, so the two share the history up to `at`
 * (entries are read through that parent link and never duplicated) and can then run side by side.
 *
 * The branch keeps the parent's title on purpose: the sidebar filters rows on it, so a branch is found
 * by searching for the session it came from.
 */
async function forkSession(row: SessionRow, at: number): Promise<{ branch: SessionRow; copied: boolean }> {
  const parent = await handleFor(row);
  const child = await parent.fork(at, { ownership: { kind: "ownerless" } }, context);
  const branch = sessions.create(Number(child.id), row.title, row.model, row.thinking, row.id, at);
  handles.set(branch.conversationId, child);
  // The copied agent doc carries the parent's cwd, so without this the two sessions would run in one
  // workspace. The child's own conversation id names its directory and cannot collide with the parent's.
  await pointAtWorkspace(branch);
  const from = workspaceDir(row.conversationId);
  const to = workspaceDir(branch.conversationId);
  let copied = false;
  if (treeSize(from) <= FORK_COPY_LIMIT_BYTES) {
    try {
      // The contents, item by item. Copying the directory itself merges or nests depending on the
      // runtime's cp semantics; the child's directory already exists by now, so merging is what we want.
      for (const item of readdirSync(from, { withFileTypes: true })) {
        cpSync(join(from, item.name), join(to, item.name), { recursive: true, force: true });
      }
      copied = true;
    } catch (err) {
      console.warn(`[pidroid] branch of session ${row.id}: workspace copy failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!copied) {
    // An empty directory is still right — the agent can work in it — it just does not start with the
    // parent's scratch in it.
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    console.warn(`[pidroid] branch of session ${row.id}: workspace left empty (limit ${Math.round(FORK_COPY_LIMIT_BYTES / 1048576)} MB)`);
  }
  return { branch, copied };
}

// The conversation that existed before sessions were introduced becomes the first session.
if (sessions.list().length === 0) {
  const legacy = await harness.root(context, { agent: { model: defaultModel() } });
  sessions.create(Number(legacy.id), "Session 1");
  handles.set(Number(legacy.id), legacy);
}
{
  const saved = Number(getState("session"));
  current = sessions.get(saved) ?? sessions.list()[0];
  root = await handleFor(current);
}
await applyThinking();

// Sessions created before per-session workspaces existed have no cwd stored and would still run in
// the app tree. Point each one at its own directory once; the marker keeps later boots from rewriting
// the doc on every start.
if (getState("workspaces") !== WORKSPACES_DIR) {
  for (const row of sessions.list()) {
    await pointAtWorkspace(row).catch(err => console.warn(`[pidroid] workspace for session ${row.id}: ${err}`));
  }
  setState("workspaces", WORKSPACES_DIR);
  console.log(`[pidroid] sessions work in ${WORKSPACES_DIR}/<session id>`);
}

// Crash-loop guard: a run that keeps killing the process must not be resumed forever. A planned restart
// (restart_server) is not a crash: its runs resume, and it doesn't count towards the guard. A user stop
// is also intentional, but unfinished runs must be aborted rather than resumed if the host relaunches us.
{
  const now = Date.now();
  const planned = now - Number(getState("planned_restart") ?? 0) < 60_000;
  const userStopped = getState("planned_stop") === "1";
  setState("planned_restart", "0");
  setState("planned_stop", "0");
  const boots: number[] = JSON.parse(getState("boots") ?? "[]").filter((t: number) => now - t < 120_000);
  if (userStopped) {
    console.log("[pidroid] previous process was stopped by the user; aborting unfinished runs");
    for (const row of sessions.list()) await (await handleFor(row)).abort(context);
  } else if (planned) {
    harness.resume(); // continue every run the previous process left unfinished
  } else {
    setState("boots", JSON.stringify([...boots, now].slice(-6)));
    if (boots.length >= 1) {
      console.warn(`[pidroid] ${boots.length} restart(s) in the last 2 minutes; aborting unfinished runs instead of resuming them`);
      for (const row of sessions.list()) await (await handleFor(row)).abort(context);
    } else {
      harness.resume();
    }
  }
}
console.log(`[pidroid] pi-durable agent ready (${AGENT_DB_PATH}), ${sessions.list().length} session(s)`);

// Live chat state for the UI. Committed messages are cached across view pushes; while the
// model streams, only the small changing tail needs to be rebuilt and sent.
let chatViewBuilder = new ChatViewBuilder();
let latestView: ChatView = chatViewBuilder.build(undefined, models, undefined, undefined, loader.views());
// Wall-clock stamps for the durations the chat view shows ("Thought · 12s", "Worked 1m 30s").
let timings = new Timings(db, current.id);
// Bumped whenever latestView changes. Every client holds the live partial of the revision it last
// received, which is what lets a streaming update carry only the text appended since.
let liveRev = 0;
function buildLatestView(value: unknown) {
  timings.stamp(value);
  liveRev++;
  return chatViewBuilder.build(value, models, timings.lookup, timings.liveStarts(), loader.views());
}
function chatPayload() {
  return {
    rev: liveRev,
    view: latestView,
    thinking: thinkingInfo(),
    model: `${pickDefaultModel().provider}/${pickDefaultModel().modelId}`,
    session: { id: current.id, title: current.title },
  };
}
function chatUpdatePayload(previousLive: ChatView["live"], previousViews: unknown, base: number) {
  return {
    rev: liveRev,
    base,
    // `null` is intentional: JSON omits undefined properties, but the browser must be able to
    // clear a live partial or run timestamp when the agent becomes idle.
    view: {
      live: liveDelta(latestView.live, previousLive),
      tools: latestView.tools,
      busy: latestView.busy,
      runStartedAt: latestView.runStartedAt ?? null,
      queue: latestView.queue,
      // The specs only change when an extension does; the page keeps the ones it has.
      toolViews: latestView.toolViews === previousViews ? undefined : latestView.toolViews,
    },
    thinking: thinkingInfo(),
    model: `${pickDefaultModel().provider}/${pickDefaultModel().modelId}`,
    session: { id: current.id, title: current.title },
  };
}
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pendingValue: unknown;
let detachView: (() => void) | undefined;

async function attachView() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = undefined;
  }
  pendingValue = undefined;
  detachView?.();
  chatViewBuilder = new ChatViewBuilder();
  const view = await root.viewState(context);
  let active = true;
  const refresh = (value: unknown) => {
    if (!active) return;
    pendingValue = value;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      const previousMessages = latestView.messages;
      const previousLive = latestView.live;
      const previousViews = latestView.toolViews;
      const base = liveRev;
      latestView = buildLatestView(pendingValue);
      // Entries are immutable and append-only. When the message-array identity is unchanged,
      // send only the stream/tool/queue tail instead of the whole transcript and its HTML.
      if (latestView.messages === previousMessages) broadcast("agent_update", chatUpdatePayload(previousLive, previousViews, base));
      else broadcast("agent_view", chatPayload());
    }, 50);
  };
  // Set the first view synchronously so a request right after a switch never sees the previous session's state.
  latestView = buildLatestView((view as any).value ?? (view as any).get?.());
  const unsubscribe = view.subscribe((value: unknown) => refresh(value));
  detachView = () => {
    active = false;
    (unsubscribe as any)?.();
    (view as any).dispose?.();
  };
}
await attachView();

async function switchTo(id: number) {
  const row = sessions.get(id);
  if (!row) throw new Error("No such session");
  current = row;
  finishedRuns.delete(row.conversationId); // opening the session is what clears its "done" mark
  timings.close();
  timings = new Timings(db, current.id);
  root = await handleFor(row);
  setState("session", String(id));
  await attachView();
  broadcast("sessions_changed", {});
  broadcast("agent_view", chatPayload());
}

/** Sessions with a run in progress or queued input, from the harness's live work. */
async function busySessions(): Promise<Set<number>> {
  const live = await harness.inspect(context);
  return new Set(live.submissions.map((s) => Number(s.conversationId)));
}

/* ---------- "done" marks ----------
   A session that was working flips from "running" to "done" in the list when its run ends, so a run
   that finished while the user was elsewhere is visibly not still running. Opening the session clears
   the mark again (switchTo), which makes it read as "there is something new in here" — and a run that
   ends in the session already on screen is not marked at all.

   Whether a run is alive is read from the harness rather than from the places a run happens to end
   (a turn settling, an abort, a run resumed after a restart), and the harness is only polled while
   something is in flight, so an idle agent pays nothing. */
const finishedRuns = new Set<number>();
const runningConversations = new Set<number>();
let runWatchTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRunWatch(delay = 1200) {
  if (runWatchTimer) clearTimeout(runWatchTimer);
  runWatchTimer = setTimeout(watchRunStates, delay);
}

async function watchRunStates() {
  runWatchTimer = undefined;
  const live = await busySessions().catch(() => null);
  if (live) for (const id of [...runningConversations]) if (!live.has(id)) markRunFinished(id);
  // Nothing left to watch: stop, and let noteRunStarted wake the watcher again.
  if (runningConversations.size > 0) scheduleRunWatch();
}

/** A run is starting: take the row's stale "done" mark away and put it under observation. */
function noteRunStarted(conversationId: number) {
  runningConversations.add(conversationId);
  if (finishedRuns.delete(conversationId)) broadcast("sessions_changed", {});
  scheduleRunWatch();
}

/**
 * The run in this conversation ended (done, errored or aborted). The session on screen is deliberately
 * left unmarked: its result is right there in the chat, so a "done" dot on it would only repeat what
 * the user is already reading. A run that ends in some other session is what the mark is for.
 */
function markRunFinished(conversationId: number, notify = true) {
  runningConversations.delete(conversationId);
  if (conversationId === current.conversationId) {
    finishedRuns.delete(conversationId); // the open session never carries a mark, not even a stale one
  } else if (finishedRuns.add(conversationId)) {
    broadcast("sessions_changed", {}); // add() reports whether this is new, so repeats stay quiet
  }
  if (runningConversations.size === 0 && runWatchTimer) {
    clearTimeout(runWatchTimer);
    runWatchTimer = undefined;
  }
  if (notify) notifyRunFinished(conversationId);
}

/* ---------- "the run you left going is done" notification ----------
   A run that ends while no browser is on screen gets an Android notification: the user put the phone
   down, and the sidebar's "done" mark is not going to say anything until they come back. While the
   page is visible nothing is posted -- the result is on screen already, and a banner over it would
   only repeat it. The banner carries the session's title and, when the session that finished is the
   one this process holds a live transcript for, the last thing the model wrote.

   A notification is a courtesy, never a step of the run: the host may be unreachable or refuse it
   (notifications switched off for the app), and that must not fail a run, so a failure is logged and
   dropped. Note that `id` is the conversation id, so the next "done" for one session replaces that
   session's own banner rather than stacking another one on it. */
const NOTIFICATION_PREVIEW_CHARS = 160;

/** The closing text of the open session's last assistant message, flattened onto one line. */
function lastAssistantLine(): string | undefined {
  const message = [...latestView.messages].reverse().find(m => m.role === "assistant");
  if (!message) return undefined;
  const text = (message.blocks ?? []).flatMap(block => (block.type === "text" ? [block.text] : [])).join(" ");
  // Markdown's furniture (headings, bullets, quotes) is noise in a one-line banner.
  const line = text.replace(/^\s*[#>*+-]+\s*/gm, "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > NOTIFICATION_PREVIEW_CHARS ? `${line.slice(0, NOTIFICATION_PREVIEW_CHARS - 1)}…` : line;
}

/** Tell the user, away from the app, that this session has stopped working. */
function notifyRunFinished(conversationId: number) {
  if (!bridgeAvailable() || watchingUi()) return;
  const row = sessions.byConversation(conversationId);
  if (!row || row.deleted) return;
  const preview = conversationId === current.conversationId ? lastAssistantLine() : undefined;
  void bridgeCall("notification.post", {
    id: conversationId,
    title: row.title,
    body: preview ?? "Finished working.",
  }).catch((err: Error) => console.warn(`[pidroid] "finished" notification for "${row.title}" failed: ${err?.message ?? err}`));
}

/* A run interrupted by a restart resumes inside this process with no request of ours to hang the
   "done" mark on, so adopt whatever the harness still calls running and let the watcher end it. */
busySessions()
  .then(live => {
    if (!live.size) return;
    for (const conversationId of live) runningConversations.add(conversationId);
    scheduleRunWatch();
  })
  .catch(() => {});

/**
 * A second connection to pi-durable's own file, opened only when a session is deleted for good.
 * Its storage object is append-only and has no delete, so the rows are removed here. WAL lets this
 * write while the harness reads, and it is held open rather than reopened per delete so the
 * prepared statements are reused.
 */
let purgeDb: Database | undefined;
function durableDb(): Database {
  if (!purgeDb) {
    // `readwrite: true`, not `create: false`. Bun builds the sqlite open flags from `readonly` /
    // `readwrite` only, and an options object that names neither leaves the flags at 0, which
    // sqlite rejects with SQLITE_MISUSE ("bad parameter or other API misuse") -- so a delete failed
    // on the open rather than on any SQL. `readwrite` also gives what `create: false` was after:
    // an existing file is opened for writing, a missing one still fails with CANTOPEN.
    purgeDb = new Database(AGENT_DB_PATH, { readwrite: true });
    // A delete can land while the harness is committing the end of the run it was just told to
    // stop; wait for that write rather than throwing SQLITE_BUSY at the user.
    purgeDb.exec("PRAGMA busy_timeout = 5000;");
  }
  return purgeDb;
}

/**
 * Remove a session's workspace directory. `force` covers the ordinary case of nothing being there;
 * the containment check is the point -- a directory outside WORKSPACES_DIR is never removed, so a
 * bug in the id that reached here cannot turn a delete into an rm -rf of the app tree.
 */
function removeWorkspace(conversationId: number) {
  const dir = workspaceDir(conversationId);
  if (dirname(dir) !== WORKSPACES_DIR || !/^\d+$/.test(basename(dir))) {
    console.warn(`[pidroid] refusing to remove ${dir}: not a workspace directory`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

async function deleteSession(id: number) {
  const row = sessions.get(id);
  if (!row) throw new Error("No such session");

  // A fork reads the history it inherited straight out of the conversation it was branched from --
  // pi-durable stores a link, never a copy -- so those entries are part of the branch's transcript
  // as much as the parent's. Deleting the parent would leave a branch that is still in the sidebar
  // missing everything before the fork point, and no way to get it back. Refuse instead, and name
  // the branches, so the user deletes those first and nothing is lost silently.
  const subtree = conversationDescendants(durableDb(), row.conversationId).filter(c => c !== row.conversationId);
  const branches = subtree
    .map(conversationId => sessions.byConversation(conversationId))
    .filter((s): s is SessionRow & { deleted: boolean } => !!s && !s.deleted);
  if (branches.length) {
    const one = branches.length === 1;
    const names = branches.map(b => `"${b.title}"`).join(", ");
    throw new Error(
      `"${row.title}" has ${one ? "a branch" : `${branches.length} branches`}: ${names}. ` +
        `A branch reads the history before the fork from the session it came from rather than keeping a ` +
        `copy, so deleting "${row.title}" would empty ${one ? "it" : "them"}. ` +
        `Delete ${one ? "the branch" : "the branches"} first.`,
    );
  }

  await (await handleFor(row)).abort(context).catch(() => {});
  handles.delete(row.conversationId);
  finishedRuns.delete(row.conversationId);
  // The stamp store for the open session writes its pending rows on a timer. Closing it here --
  // before the rows below are deleted -- is what stops it re-inserting timings for a session id
  // that no longer exists a moment later.
  if (current.id === id) timings.close();

  // Already-hidden branches of this session come out with it: they are gone from the sidebar
  // already, and their history is only reachable through the transcript being deleted.
  const purged = purgeConversations(durableDb(), [row.conversationId, ...subtree]);
  for (const conversationId of [row.conversationId, ...subtree]) {
    removeWorkspace(conversationId);
    const owned = sessions.byConversation(conversationId);
    if (owned) sessions.purge(owned.id);
  }
  console.log(
    `[pidroid] deleted session ${row.id} (conversation ${row.conversationId}): ` +
      `${purged.conversations} conversations, ${purged.entries} entries, ${purged.tasks} tasks, ` +
      `${purged.submissions} submissions, ${purged.documents} documents`,
  );

  if (current.id === id) {
    const next = sessions.list()[0] ?? (await createSession());
    await switchTo(next.id);
  } else {
    broadcast("sessions_changed", {});
  }
}

/* ---------- transcripts ----------
   A session's log as something you can keep, read straight out of pi-durable rather than out of
   the chat view: no 150-message window, no clipped tool output, and it works for a session that is
   not the one on screen. transcript.ts owns the parsing and both renderings; this is the plumbing
   that finds the log, the wall clock and a file to put the result in. */

/** Shared storage, where an exported transcript can actually be found off the phone. */
const TRANSCRIPT_DIR = "/storage/emulated/0/Download";

/** The session's wall-clock stamps, read from the same table timings.ts writes. */
function stampsFor(sessionId: number): (key: string) => number | undefined {
  const rows = db.query("SELECT key, at FROM timings WHERE session = ?").all(sessionId) as { key: string; at: number }[];
  if (!rows.length) return () => undefined;
  const map = new Map(rows.map(r => [r.key, r.at]));
  return key => map.get(key);
}

async function transcriptFor(row: SessionRow, options: { thinking?: boolean; tools?: boolean } = {}) {
  const conversation = await handleFor(row);
  // One observer of its own, so reading a transcript neither disturbs the live view of the open
  // session nor keeps a mount alive for a session nobody is looking at.
  const view = await conversation.viewState(context);
  try {
    const value = (view as any).value ?? (view as any).get?.();
    const messages = buildTranscript(value?.entries, {
      thinking: options.thinking,
      tools: options.tools,
      stamps: stampsFor(row.id),
      // A run still going has its committed messages in the log already; only the tail is here.
      live: value?.docs?.["pi.live"],
    });
    const parent = row.parentSessionId !== null ? sessions.get(row.parentSessionId) : undefined;
    const meta: TranscriptMeta = {
      title: row.title,
      sessionId: row.id,
      conversationId: row.conversationId,
      model: row.model,
      thinking: row.thinking,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      branchedFrom: parent?.title,
      forkEntryId: row.forkEntryId,
    };
    return { messages, meta };
  } finally {
    (view as any).dispose?.();
  }
}

/** Both renderings of one transcript, so the two files on disk cannot disagree. */
function transcriptFiles(row: SessionRow, messages: TranscriptMessage[], meta: TranscriptMeta, when = new Date()) {
  const stem = transcriptFileName(row.title, when);
  return [
    { name: `${stem}.md`, body: transcriptToMarkdown(messages, meta) },
    { name: `${stem}.json`, body: transcriptToJson(messages, meta) },
  ];
}

/**
 * Write the transcript into shared storage, never overwriting an earlier export: two sessions
 * with the same title exported in the same minute would otherwise silently replace each other.
 * Returns the paths actually written. Falls back to the app tree if shared storage is not writable
 * (a device where the folder is missing), which still leaves the file somewhere reachable.
 */
function saveTranscript(row: SessionRow, messages: TranscriptMessage[], meta: TranscriptMeta) {
  const files = transcriptFiles(row, messages, meta);
  const dirs = [TRANSCRIPT_DIR, join(APP_DIR, "exports")];
  let lastError: unknown;
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      for (const file of files) {
        let path = join(dir, file.name);
        for (let n = 2; existsSync(path); n++) path = join(dir, `${file.name.replace(/(\.[^.]+)$/, `-${n}$1`)}`);
        writeFileSync(path, file.body, "utf-8");
        written.push(path);
      }
      return written;
    } catch (err) {
      lastError = err;
      console.warn(`[pidroid] transcript export to ${dir} failed`, err);
    }
  }
  throw new Error(`Could not write the transcript: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function answerText(entry: any): string {
  const message = entry?.model?.[0];
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("")
    .trim();
}

/**
 * Title for a session when no title model is picked (or the one picked failed): the opening line of
 * what the user asked, stripped of markdown and clipped to sit on one row in the session list.
 */
function messageTitle(firstMessage: string): string {
  const line = firstMessage
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  const cleaned = line
    .replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();
  if (cleaned.length <= 64) return cleaned;
  const clipped = cleaned.slice(0, 64);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** Store a generated title, unless the session was renamed by hand or deleted in the meantime. */
function applyGeneratedTitle(sessionId: number, title: string): boolean {
  if (!title) return false;
  const row = sessions.get(sessionId);
  if (!row || row.title !== DEFAULT_TITLE) return false;
  sessions.rename(sessionId, title);
  const updated = sessions.get(sessionId);
  if (updated && current.id === sessionId) {
    current = updated;
    broadcast("agent_view", chatPayload());
  }
  broadcast("sessions_changed", {});
  return true;
}

/** Tell the page that a title job started, or that it gave up and why. Purely informational:
   nothing here reads it back, and a page that never sees it (backgrounded, no browser) loses
   nothing -- the title still lands in the database either way. `detail` is the model on the way
   in and the reason on the way out. */
function noteTitleStatus(sessionId: number, state: "started" | "failed", detail?: string) {
  broadcast("title_status", { sessionId, state, detail });
}

/**
 * What a title is written from: the message the conversation opened with, plus the answer that came
 * back. Two texts rather than one because the first message is often "do this thing" and the reply
 * is what says what the thing was -- both are clipped so a pasted log cannot eat the whole prompt.
 */
function titleSource(messages: ChatView["messages"]): string {
  const asked = messages.find((m) => m.role === "user")?.text?.trim() ?? "";
  const answered = messages.find((m) => m.role === "assistant")?.text?.trim() ?? "";
  if (!asked) return answered.slice(0, 4000);
  if (!answered) return asked.slice(0, 4000);
  return `${asked.slice(0, 4000)}\n\nThe assistant began its answer with:\n${answered.slice(0, 1200)}`;
}

/** Ask one model for a title and scrub the reply down to a bare title. Throws on a provider error;
    undefined means the model answered with nothing usable after scrubbing. */
async function titleFromModel(model: any, source: string): Promise<string | undefined> {
  const stream = models.streamSimple(model, {
    messages: [{
      role: "user",
      content: `Write a concise, descriptive title for this conversation in at most 8 words. Return only the title, with no quotes or explanation.\n\nThe conversation so far:\n${source}`,
    }],
  });
  const result = await stream.result();
  if (result.stopReason === "error" || result.errorMessage) {
    throw new Error(result.errorMessage || "Title model returned an error");
  }
  const generated = (result.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join(" ")
    .split(/\r?\n/, 1)[0]
    .replace(/^\s*(?:title|conversation title)\s*:\s*/i, "")
    .replace(/^\s*#+\s*/, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return generated || undefined;
}

/** The committed transcript of a session, read from storage for any row -- the open session already
    has its view built and is used from there. */
async function messagesOf(row: SessionRow): Promise<ChatView["messages"]> {
  if (row.id === current.id) return latestView.messages;
  const view = new ChatViewBuilder().build(await (await handleFor(row)).viewState(context), models);
  return view.messages;
}

/**
 * Write a title the user asked for, replacing whatever was on the session. This deliberately
 * overwrites a hand-written title -- asking for a new one is the point -- unlike the automatic path,
 * which stands down the moment a session has a name of its own.
 */
async function writeGeneratedTitle(row: SessionRow, source: string): Promise<string> {
  // The title model when one is picked (that is what it is for), else the model this session
  // already runs on: a manual "generate" is a deliberate request for a model to think about the
  // name, and this one is already configured, signed in and paid for.
  const key = titleModelPreference()?.key ?? row.model;
  const [provider, ...rest] = key.split("/");
  const model = models.getModel(provider, rest.join("/"));
  if (!model) throw new Error(`${key} is not available`);
  const title = await titleFromModel(model, source);
  if (!title) throw new Error("the model returned an empty title");
  if (row.title !== title) {
    sessions.rename(row.id, title);
    broadcast("sessions_changed", {});
  }
  if (current.id === row.id) {
    current = sessions.get(row.id) ?? current;
    broadcast("agent_view", chatPayload());
  }
  return title;
}

/** The route behind the popup's "Generate": write a fresh title from the conversation so far. */
async function regenerateTitle(row: SessionRow): Promise<{ title: string; model: string }> {
  const source = titleSource(await messagesOf(row));
  if (!source.trim()) throw new Error("Send a message first -- there is nothing to name this session after yet");
  if (titleGenerationJobs.has(row.id)) throw new Error("a title is already being written for this session");
  titleGenerationJobs.add(row.id);
  noteTitleStatus(row.id, "started", titleModelPreference()?.key ?? row.model);
  try {
    const title = await writeGeneratedTitle(row, source);
    return { title, model: titleModelPreference()?.key ?? row.model };
  } catch (err) {
    console.warn(`[pidroid] title generation failed for session ${row.id}:`, err);
    noteTitleStatus(row.id, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    titleGenerationJobs.delete(row.id);
  }
}

const titleGenerationJobs = new Set<number>();
function scheduleTitleGeneration(sessionId: number, firstMessage: string) {
  const preference = titleModelPreference();
  if (!preference) {
    // Auto titles are off: the conversation is named after the message that opened it.
    applyGeneratedTitle(sessionId, messageTitle(firstMessage));
    return;
  }
  if (titleGenerationJobs.has(sessionId)) return;
  titleGenerationJobs.add(sessionId);
  noteTitleStatus(sessionId, "started", preference.key);

  void (async () => {
    try {
      const model = models.getModel(preference.provider, preference.modelId);
      if (!model) {
        noteTitleStatus(sessionId, "failed", `${preference.key} is no longer available`);
        return;
      }
      const generated = await titleFromModel(model, firstMessage.slice(0, 4000));
      if (!generated) {
        // Scrubbing can leave nothing behind (an empty or punctuation-only reply), and the
        // fallback below is only for a thrown error -- so say so rather than leave the session
        // on "New session" with no word about why.
        noteTitleStatus(sessionId, "failed", "the model returned an empty title");
        return;
      }

      // Respect a manual rename, a changed title-model preference, or a deleted session.
      if (titleModelPreference()?.key !== preference.key) return;
      applyGeneratedTitle(sessionId, generated);
    } catch (err) {
      console.warn(`[pidroid] title generation failed for session ${sessionId}:`, err);
      noteTitleStatus(sessionId, "failed", err instanceof Error ? err.message : String(err));
      // Better a plain title from the message than a session stuck on "New session".
      if (titleModelPreference()?.key === preference.key) applyGeneratedTitle(sessionId, messageTitle(firstMessage));
    } finally {
      titleGenerationJobs.delete(sessionId);
    }
  })();
}

// Watch www directory for direct agent modifications
if (existsSync(WWW_DIR)) {
  try {
    const { watch } = await import("fs");
    watch(WWW_DIR, { recursive: true }, (eventType, filename) => {
      console.log(`[pidroid] Detected UI modification (${eventType}): ${filename}`);
      requestUiReload(filename);
    });
  } catch (err) {
    console.warn("[pidroid] File watcher warning:", err);
  }
}

// Compile the wasm engine and the common grammars now, off the request path, so the first file
// someone opens does not eat the ~0.5s cold start. Fire-and-forget: highlighting is optional.
warmHighlighter();

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for real-time agent updates and UI hot-reload
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API Routes
    if (url.pathname === "/api/status") {
      const messageCount = db.query("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      return Response.json({
        status: "online",
        // "full" only this server can report. The app's recovery (fallback) server has no `mode`
        // field, so the UI treats its absence as "not the real server" and says so on screen.
        mode: "full",
        runtime: "bun",
        version: Bun.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: DB_PATH,
        messageCount: messageCount?.count ?? 0,
      });
    }

    if (url.pathname === "/api/messages" && req.method === "GET") {
      const messages = db.query("SELECT * FROM messages ORDER BY id ASC").all();
      return Response.json({ messages });
    }

    if (url.pathname === "/api/usage/stats" && req.method === "GET") {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday, local time
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const dailyStart = new Date(todayStart);
      dailyStart.setDate(dailyStart.getDate() - 29);
      const weeklyStart = new Date(weekStart);
      weeklyStart.setDate(weeklyStart.getDate() - 7 * 11);
      const monthlyStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      const selectedProvider = url.searchParams.get("provider")?.trim() || "";
      const selectedModel = url.searchParams.get("model")?.trim() || ""; // canonical provider/model key
      const filterClauses: string[] = [];
      const filterBindings: (string | number)[] = [];
      if (selectedProvider) {
        filterClauses.push("provider = ?");
        filterBindings.push(selectedProvider);
      }
      if (selectedModel) {
        filterClauses.push("(provider || '/' || model) = ?");
        filterBindings.push(selectedModel);
      }
      const whereFor = (start?: number, prefix = "") => {
        const clauses = filterClauses.map((clause) => prefix ? clause.replaceAll("provider", `${prefix}provider`).replaceAll("model", `${prefix}model`) : clause);
        if (start !== undefined) clauses.push(`${prefix}captured_at >= ?`);
        return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      };
      const bindingsFor = (start?: number) => start === undefined ? [...filterBindings] : [...filterBindings, start];

      const total = (start?: number) => {
        const raw = db.query(`
          SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
                 COALESCE(SUM(output_tokens), 0) AS outputTokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
                 COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
                 COALESCE(SUM(total_tokens), 0) AS tokens,
                 SUM(cost_total) AS cost,
                 COUNT(cost_total) AS pricedResponses,
                 COUNT(*) AS responses,
                 COUNT(DISTINCT u.session_id) AS sessions
          FROM token_usage_events u
          JOIN sessions s ON u.session_id = s.id AND s.deleted = 0 ${whereFor(start, "u.")}
        `).get(...bindingsFor(start)) as any;
        return {
          inputTokens: Number(raw?.inputTokens ?? 0),
          outputTokens: Number(raw?.outputTokens ?? 0),
          cacheReadTokens: Number(raw?.cacheReadTokens ?? 0),
          cacheWriteTokens: Number(raw?.cacheWriteTokens ?? 0),
          tokens: Number(raw?.tokens ?? 0),
          cost: raw?.cost === null || raw?.cost === undefined ? null : Number(raw.cost),
          pricedResponses: Number(raw?.pricedResponses ?? 0),
          responses: Number(raw?.responses ?? 0),
          sessions: Number(raw?.sessions ?? 0),
        };
      };
      const normalizeUsageRow = (row: any) => ({
        ...row,
        tokens: Number(row.tokens ?? 0),
        inputTokens: Number(row.inputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
        cacheReadTokens: Number(row.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
        cost: row.cost === null || row.cost === undefined ? null : Number(row.cost),
        pricedResponses: Number(row.pricedResponses ?? 0),
        responses: Number(row.responses ?? 0),
      });
      const grouped = (bucket: string, start: number) => (db.query(`
        SELECT ${bucket} AS bucket,
               COALESCE(SUM(total_tokens), 0) AS tokens,
               COALESCE(SUM(input_tokens), 0) AS inputTokens,
               COALESCE(SUM(output_tokens), 0) AS outputTokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
               COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
               SUM(cost_total) AS cost,
               COUNT(cost_total) AS pricedResponses,
               COUNT(*) AS responses
        FROM token_usage_events u
        JOIN sessions s ON u.session_id = s.id AND s.deleted = 0 ${whereFor(start, "u.")}
        GROUP BY bucket
        ORDER BY bucket ASC
      `).all(...bindingsFor(start)) as any[]).map(normalizeUsageRow);

      const sessionJoinFilters: string[] = [];
      const sessionBindings: string[] = [];
      if (selectedProvider) {
        sessionJoinFilters.push("u.provider = ?");
        sessionBindings.push(selectedProvider);
      }
      if (selectedModel) {
        sessionJoinFilters.push("(u.provider || '/' || u.model) = ?");
        sessionBindings.push(selectedModel);
      }
      const sessionFilterSql = sessionJoinFilters.length ? ` AND ${sessionJoinFilters.join(" AND ")}` : "";
      const sessions = db.query(`
        SELECT s.id, s.title, s.created_at AS createdAt,
               COALESCE(SUM(u.total_tokens), 0) AS tokens,
               COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
               COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
               COALESCE(SUM(u.cache_read_tokens), 0) AS cacheReadTokens,
               COALESCE(SUM(u.cache_write_tokens), 0) AS cacheWriteTokens,
               SUM(u.cost_total) AS cost,
               COUNT(u.cost_total) AS pricedResponses,
               COUNT(u.event_key) AS responses,
               MAX(u.captured_at) AS lastUsedAt
        FROM sessions s
        LEFT JOIN token_usage_events u ON u.session_id = s.id${sessionFilterSql}
        WHERE s.deleted = 0
        GROUP BY s.id
        HAVING COUNT(u.event_key) > 0
        ORDER BY tokens DESC, s.updated_at DESC
      `).all(...sessionBindings) as any[];
      const normalizedSessions = sessions.map((row) => ({
        ...normalizeUsageRow(row),
        id: Number(row.id),
        createdAt: Number(row.createdAt),
        lastUsedAt: row.lastUsedAt === null || row.lastUsedAt === undefined ? null : Number(row.lastUsedAt),
      }));

      const dayBucket = "strftime('%Y-%m-%d', captured_at / 1000, 'unixepoch', 'localtime')";
      const weekBucket = `date(
        captured_at / 1000, 'unixepoch', 'localtime',
        printf('-%d days', (CAST(strftime('%w', captured_at / 1000, 'unixepoch', 'localtime') AS INTEGER) + 6) % 7)
      )`;
      const monthBucket = "strftime('%Y-%m', captured_at / 1000, 'unixepoch', 'localtime')";
      const providers = (db.query("SELECT DISTINCT u.provider FROM token_usage_events u JOIN sessions s ON u.session_id = s.id AND s.deleted = 0 ORDER BY u.provider").all() as { provider: string }[])
        .map((row) => row.provider);
      const availableModels = db.query("SELECT DISTINCT u.provider, u.model FROM token_usage_events u JOIN sessions s ON u.session_id = s.id AND s.deleted = 0 ORDER BY u.provider, u.model").all() as { provider: string; model: string }[];
      return Response.json({
        generatedAt: Date.now(),
        filters: { provider: selectedProvider, model: selectedModel, providers, models: availableModels },
        allTime: total(),
        today: total(todayStart.getTime()),
        thisWeek: total(weekStart.getTime()),
        thisMonth: total(monthStart.getTime()),
        sessions: normalizedSessions,
        daily: grouped(dayBucket, dailyStart.getTime()),
        weekly: grouped(weekBucket, weeklyStart.getTime()),
        monthly: grouped(monthBucket, monthlyStart.getTime()),
      });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      return req.json().then(async (body: { message?: string; attachments?: AgentImageAttachment[] }) => {
        const text = body.message?.trim() ?? "";
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        if (!text && !attachments.length) {
          return Response.json({ error: "Message or image attachment is required" }, { status: 400 });
        }
        const refs = attachments.map((attachment, index) => {
          const label = attachment?.label && /^Image #\d+$/.test(attachment.label) ? attachment.label : `Image #${index + 1}`;
          return text.includes(`[${label}]`) ? "" : `[${label}]`;
        }).filter(Boolean);
        const visibleText = [text, refs.join(" ")].filter(Boolean).join(" ");
        const agentInput = agentInputContent(visibleText, attachments);
        if (agentInput.error) {
          return Response.json({ error: agentInput.error }, { status: 413 });
        }

        // Store user message
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("user", visibleText);
        broadcast("message", { role: "user", content: visibleText });

        let replyText: string;
        const conv = root; // a session switch mid-run must not redirect this request
        const session = current;
        if (session.title === DEFAULT_TITLE) scheduleTitleGeneration(session.id, visibleText);
        sessions.touch(session.id);
        noteRunStarted(session.conversationId); // the row switches to "running" until this settles
        // Capture manual edits first so the turn commit holds only what the agent changed.
        await changes.snapshot("[edits] Changes made outside the agent").catch(() => {});
        try {
          // A message sent while the agent is working is "steered": it is placed after the current step (model response and its
        // tool calls) and joins the running work, instead of waiting for the entire run to finish.
        const submission = await conv.submit({ type: "input", content: agentInput.content, whenBusy: "steer" } as any, context);
          const settled = await submission.wait(context);
          if (settled.status === "done" && settled.type === "input") {
            const answer = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
            replyText = answerText(answer) || "(no text in reply)";
          } else {
            replyText = `Agent could not answer: ${JSON.stringify(settled)}`;
          }
        } catch (err) {
          replyText = `Agent error: ${err instanceof Error ? err.message : String(err)}`;
        }
        markRunFinished(session.conversationId); // done, aborted or errored: the run is over either way
        const turnOid = await changes
          .snapshot(`[turn] ${visibleText.replace(/\s+/g, " ").slice(0, 80)}\n\nsession: ${session.title}\nmodel: ${pickDefaultModel().provider}/${pickDefaultModel().modelId}`)
          .catch(() => null);
        if (turnOid) broadcast("changes", { oid: turnOid });
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("assistant", replyText);
        broadcast("message", { role: "assistant", content: replyText });

        return Response.json({ success: true, reply: replyText });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      const agent = pickDefaultModel();
      const fallback = defaultModel();
      const titleModel = titleModelPreference()?.key ?? "";
      return logins.providers().then(providers => {
        // Usable = signed-in providers, plus the anonymous OpenCode free tier.
        const usable = new Set(providers.filter(p => p.configured).map(p => p.id));
        usable.add("opencode");
        const names = new Map(models.getProviders().map(p => [p.id, p.name ?? p.id]));
        return Response.json({
          current: `${agent.provider}/${agent.modelId}`,
          default: `${fallback.provider}/${fallback.modelId}`,
          titleModel,
          models: models.getModels()
            .filter(m => usable.has(m.provider) || (m.provider === agent.provider && m.id === agent.modelId) || `${m.provider}/${m.id}` === titleModel)
            .map((m) => ({
              id: `${m.provider}/${m.id}`,
              name: m.name,
              provider: m.provider,
              providerName: names.get(m.provider),
              reasoning: m.reasoning,
              image: m.input.includes("image"),
              contextWindow: m.contextWindow,
            })),
        });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Picking a model in the chooser applies to the current session only. The default for new
    // sessions is set deliberately -- the chooser's star, or this route.
    if (url.pathname === "/api/model" && req.method === "POST") {
      return req.json().then(async (body: { model?: string }) => {
        const [provider, ...rest] = (body.model ?? "").split("/");
        const modelId = rest.join("/");
        if (!models.getModel(provider, modelId)) {
          return Response.json({ error: `Unknown model: ${body.model}` }, { status: 400 });
        }
        const nextModel = `${provider}/${modelId}`;
        const previousModel = `${pickDefaultModel().provider}/${pickDefaultModel().modelId}`;
        await root.configure({ model: { provider, modelId } }, context);
        const hasTranscript = latestView.messages.some((message) => message.role === "user" || message.role === "assistant");
        if (nextModel !== previousModel && hasTranscript) {
          await root.commit((tx) => tx.appendEntry(ModelChangeEntry, Number(root.id), {
            data: { fromModel: previousModel, toModel: nextModel, switchedAt: Date.now() },
          }), context);
        }
        sessions.setModel(current.id, nextModel);
        current = sessions.get(current.id) ?? current;
        await applyThinking();
        broadcast("agent_view", chatPayload());
        return Response.json({ success: true, current: body.model });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/model/default" && req.method === "POST") {
      return req.json().then((body: { model?: string }) => {
        const [provider, ...rest] = (body.model ?? "").split("/");
        const modelId = rest.join("/");
        if (!models.getModel(provider, modelId)) {
          return Response.json({ error: `Unknown model: ${body.model}` }, { status: 400 });
        }
        setState("model", `${provider}/${modelId}`);
        console.log(`[pidroid] default model is now ${provider}/${modelId}`);
        // The session on screen keeps its own model: setting a default is not a silent switch.
        return Response.json({ success: true, default: `${provider}/${modelId}` });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/title-model" && req.method === "POST") {
      return req.json().then((body: { model?: string }) => {
        const selected = (body.model ?? "").trim();
        if (!selected || selected === "none") {
          setState("title_model", "");
          return Response.json({ success: true, model: "" });
        }
        const [provider, ...rest] = selected.split("/");
        const modelId = rest.join("/");
        if (!models.getModel(provider, modelId)) {
          return Response.json({ error: `Unknown title model: ${selected}` }, { status: 400 });
        }
        setState("title_model", `${provider}/${modelId}`);
        return Response.json({ success: true, model: `${provider}/${modelId}` });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Re-fetch OpenCode free / Command Code catalogs ({ "providers": ["opencode"] } or omit for both).
    if (url.pathname === "/api/models/refresh" && req.method === "POST") {
      return req.json().catch(() => ({})).then(async (body: { providers?: string[] }) => {
        const result = await models.refresh({
          providers: body.providers ?? ["opencode", "commandcode"],
          signal: AbortSignal.timeout(15000),
          force: true,
        });
        return Response.json({
          aborted: result.aborted,
          errors: Object.fromEntries([...result.errors].map(([id, e]) => [id, e.message])),
        });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/commandcode/usage" && req.method === "GET") {
      return providerApiKey("commandcode")
        .then(key => commandCodeUsage(key))
        .then(text => Response.json({ usage: text }))
        .catch(err => Response.json({ error: String(err) }, { status: 502 }));
    }

    // --- Provider auth (OpenCode is anonymous and hidden) ---
    if (url.pathname === "/api/providers" && req.method === "GET") {
      return logins.providers()
        .then(providers => Response.json({
          providers: providers.map(p => ({ ...p, usage: p.configured && !!usageSources[p.id] })),
        }))
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Live usage for a signed-in provider: plan, credit windows and period totals.
    const usageRoute = url.pathname.match(/^\/api\/providers\/([^/]+)\/usage$/);
    if (usageRoute && req.method === "GET") {
      const providerId = decodeURIComponent(usageRoute[1]);
      const source = usageSources[providerId];
      if (!source) return Response.json({ error: `${providerId} does not report usage` }, { status: 400 });
      return providerApiKey(providerId)
        .then(key => {
          if (!key) throw new Error(`${providerId} is not signed in`);
          return source(key, AbortSignal.timeout(20_000));
        })
        .then(usage => Response.json({ usage }))
        .catch((err: Error) => Response.json({ error: err?.message ?? String(err) }, { status: 502 }));
    }

    const providerRoute = url.pathname.match(/^\/api\/providers\/([^/]+)\/(login|key|logout)$/);
    if (providerRoute && req.method === "POST") {
      const providerId = decodeURIComponent(providerRoute[1]);
      const action = providerRoute[2];
      return req.json().catch(() => ({})).then(async (body: { type?: "oauth" | "api_key"; key?: string }) => {
        if (action === "login") {
          return Response.json({ loginId: logins.start(providerId, body.type === "api_key" ? "api_key" : "oauth") });
        }
        if (action === "key") {
          await logins.saveApiKey(providerId, body.key ?? "");
        } else {
          await logins.logout(providerId);
        }
        broadcast("providers_changed", { providerId });
        return Response.json({ success: true });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    const loginRoute = url.pathname.match(/^\/api\/login\/([^/]+)\/(answer|cancel)$/);
    if (loginRoute && req.method === "POST") {
      const loginId = decodeURIComponent(loginRoute[1]);
      return req.json().catch(() => ({})).then((body: { promptId?: string; value?: string }) => {
        if (loginRoute[2] === "cancel") logins.cancel(loginId);
        else logins.answer(loginId, body.promptId ?? "", body.value ?? "");
        return Response.json({ success: true });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    // --- Self-modification ---
    if (url.pathname === "/api/reload" && req.method === "POST") {
      return loader.reload().then(r => Response.json(r)).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Shared Agent Skills are data files, discovered on demand from the app-private user skills directory.
    if (url.pathname === "/api/skills" && req.method === "GET") {
      try {
        return Response.json({ directory: SKILLS_DIR, skills: discoverSkills() });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Extensions: the settings tab lists them and toggles each one. Turning one off stores the choice and
    // reloads in the same step, so what the list shows is what is actually installed.
    if (url.pathname === "/api/extensions" && req.method === "GET") {
      return Response.json({ extensions: loader.list() });
    }

    if (url.pathname === "/api/extensions/toggle" && req.method === "POST") {
      return req.json()
        .then((body: { file?: string; enabled?: boolean }) => {
          if (!body.file || !loader.list().some((e) => e.file === body.file)) throw new Error("No such extension file");
          setExtensionEnabled(body.file, body.enabled !== false);
          return loader.reload();
        })
        .then(reload => Response.json({ success: true, extensions: loader.list(), reload }))
        .catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      return preflight().then(problem => {
        if (problem) return Response.json({ error: `server.ts does not build:\n${problem}` }, { status: 409 });
        scheduleRestart(300);
        return Response.json({ success: true });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      scheduleStop(500); // leave time for this response and the UI confirmation to reach the WebView
      return Response.json({ success: true, stopping: true });
    }

    // --- Sessions ---
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return busySessions().then(busy => Response.json({
        current: current.id,
        // Depth-ordered forest: branches sit under the session they came from.
        sessions: sessions.tree().map(({ row, depth }) => ({
          ...row,
          depth,
          busy: busy.has(row.conversationId),
          // A run that ended and hasn't been looked at yet: the sidebar shows "done" instead of "running".
          done: finishedRuns.has(row.conversationId),
        })),
      })).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Branching posts to the collection rather than to a row: the id names the session and `at` names an
    // entry inside it, which /api/sessions/:id/fork would wrongly imply is the entry.
    if (url.pathname === "/api/sessions/fork" && req.method === "POST") {
      return req.json().then(async (body: { id?: number; at?: number }) => {
        const row = sessions.get(Number(body.id));
        if (!row) throw new Error("No such session");
        const at = Number(body.at);
        if (!Number.isSafeInteger(at) || at < 1) throw new Error("No entry to branch at");
        const { branch, copied } = await forkSession(row, at);
        await switchTo(branch.id); // also announces the new session
        return Response.json({ success: true, id: branch.id, copied });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      return createSession()
        .then(async row => { await switchTo(row.id); return Response.json({ success: true, id: row.id }); })
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    const sessionRoute = url.pathname.match(/^\/api\/sessions\/(\d+)\/(switch|rename|delete|title)$/);
    if (sessionRoute && req.method === "POST") {
      const id = Number(sessionRoute[1]);
      if (sessionRoute[2] === "title") {
        const row = sessions.get(id);
        if (!row) return Response.json({ error: "No such session" }, { status: 404 });
        // Awaits the model rather than reporting back: the page is waiting on the new title to put
        // in the box, and there is nothing else for it to do with a "started" it cannot trust.
        return regenerateTitle(row)
          .then(({ title, model }) => Response.json({ success: true, title, model }))
          .catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
      }
      return req.json().catch(() => ({})).then(async (body: { title?: string }) => {
        if (sessionRoute[2] === "switch") await switchTo(id);
        else if (sessionRoute[2] === "rename") {
          if (!sessions.get(id)) throw new Error("No such session");
          sessions.rename(id, body.title ?? "");
          if (current.id === id) current = sessions.get(id) ?? current;
          broadcast("sessions_changed", {});
          broadcast("agent_view", chatPayload());
        } else await deleteSession(id);
        return Response.json({ success: true, current: current.id });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    // The transcript itself, as text. The page fetches this to copy a session to the clipboard,
    // and it is also the honest download endpoint: the same bytes the export writes to disk.
    const transcriptRoute = url.pathname.match(/^\/api\/sessions\/(\d+)\/transcript$/);
    if (transcriptRoute && req.method === "GET") {
      const row = sessions.get(Number(transcriptRoute[1]));
      if (!row) return Response.json({ error: "No such session" }, { status: 404 });
      const asJson = url.searchParams.get("format") === "json";
      const flag = (name: string) => url.searchParams.get(name) !== "0";
      return transcriptFor(row, { thinking: flag("thinking"), tools: flag("tools") })
        .then(({ messages, meta }) => {
          const body = asJson ? transcriptToJson(messages, meta) : transcriptToMarkdown(messages, meta);
          const name = `${transcriptFileName(row.title)}.${asJson ? "json" : "md"}`;
          return new Response(body, {
            headers: {
              "Content-Type": asJson ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
              "Content-Disposition": `attachment; filename="${name}"`,
              "Cache-Control": "no-store",
            },
          });
        })
        .catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }));
    }

    // Write the transcript to shared storage as Markdown and JSON.
    const exportRoute = url.pathname.match(/^\/api\/sessions\/(\d+)\/export$/);
    if (exportRoute && req.method === "POST") {
      const row = sessions.get(Number(exportRoute[1]));
      if (!row) return Response.json({ error: "No such session" }, { status: 404 });
      return req.json().catch(() => ({})).then((body: { thinking?: boolean; tools?: boolean }) =>
        transcriptFor(row, { thinking: body.thinking, tools: body.tools }).then(({ messages, meta }) => {
          const paths = saveTranscript(row, messages, meta);
          console.log(`[pidroid] exported session ${row.id} transcript to ${paths.join(", ")}`);
          return Response.json({
            success: true,
            paths,
            dir: dirname(paths[0]),
            counts: countMessages(messages),
            bytes: paths.map(p => statSync(p).size),
          });
        }),
      ).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }));
    }

    // --- Live chat ---
    if (url.pathname === "/api/view" && req.method === "GET") return Response.json(chatPayload());

    if (url.pathname === "/api/abort" && req.method === "POST") {
      const conversationId = current.conversationId;
      return root.abort(context)
        // No notification: the user is the one who asked for the stop, so they are looking at the app.
        .then(() => { markRunFinished(conversationId, false); return Response.json({ success: true }); })
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/thinking" && req.method === "POST") {
      return req.json().then(async (body: { level?: string }) => {
        const info = thinkingInfo();
        if (!body.level || !(info.levels as string[]).includes(body.level)) {
          return Response.json({ error: `Unsupported level for this model. Choose one of: ${info.levels.join(", ")}` }, { status: 400 });
        }
        setState("thinking", body.level);
        sessions.setThinking(current.id, body.level);
        current = sessions.get(current.id) ?? current;
        await applyThinking();
        const hasTranscript = latestView.messages.some((message) => message.role === "user" || message.role === "assistant");
        if (body.level !== info.current && hasTranscript) {
          await root.commit((tx) => tx.appendEntry(ThinkingChangeEntry, Number(root.id), {
            data: { fromLevel: info.current, toLevel: body.level, switchedAt: Date.now() },
          }), context);
        }
        broadcast("agent_view", chatPayload());
        return Response.json({ success: true, thinking: thinkingInfo() });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Tokenise both sides of a tool-call diff so the chat preview can colour it. The chat's diff is
    // computed in the browser from tool arguments, not read from git, so there is no patch to walk
    // here -- just two blobs of text and the path that says what language they are.
    if (url.pathname === "/api/diff/colours" && req.method === "POST") {
      const MAX_SIDE = 200 * 1024;
      return req.json()
        .then((body: { before?: unknown; after?: unknown; path?: unknown }) => {
          const before = typeof body.before === "string" ? body.before : "";
          const after = typeof body.after === "string" ? body.after : "";
          const lang = typeof body.path === "string" ? languageFor(body.path) : null;
          if (!lang) return { lang: null, oldRows: null, newRows: null };
          if (before.length > MAX_SIDE || after.length > MAX_SIDE || before.length + after.length > MAX_INTERACTIVE_CHARS) {
            return { lang, oldRows: null, newRows: null };
          }
          return Promise.all([highlight(before, lang), highlight(after, lang)]).then(([oldLit, newLit]) => ({
            lang,
            oldRows: oldLit ? oldLit.lines.map((l) => l.html) : null,
            newRows: newLit ? newLit.lines.map((l) => l.html) : null,
          }));
        })
        .then((payload: object) => Response.json(payload))
        .catch(() => Response.json({ lang: null, oldRows: null, newRows: null }));
    }

    // Syntax colours for a code fence in a chat reply. The language is the fence's name (ts, python...),
    // and the answer is one HTML string per line, or null when there is nothing to colour.
    if (url.pathname === "/api/highlight" && req.method === "POST") {
      return req.json()
        .then(async (body: { code?: unknown; lang?: unknown }) => {
          const code = typeof body.code === "string" ? body.code : "";
          // Fence tags, not file extensions: ```console or ```svg have no extension of their own.
          const lang = typeof body.lang === "string" ? fenceLanguage(body.lang) : null;
          const lit = lang && code.length <= MAX_INTERACTIVE_CHARS ? await highlight(code, lang) : null;
          return { lang, rows: lit ? lit.lines.map((l) => l.html) : null };
        })
        .then((payload: object) => Response.json(payload))
        .catch(() => Response.json({ lang: null, rows: null }));
    }

    // --- Change tracking ---
    if (url.pathname === "/api/changes" && req.method === "GET") {
      return changes.list(Number(url.searchParams.get("limit")) || 60)
        .then(entries => Response.json({ entries }))
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    const changeRoute = url.pathname.match(/^\/api\/changes\/([0-9a-f]{40})\/(files|diff|undo|restore)$/);
    if (changeRoute) {
      const [, oid, action] = changeRoute;
      const respond = (work: Promise<unknown>) =>
        work.then(result => {
          if (action === "undo" || action === "restore") broadcast("changes", {});
          return Response.json(result as object);
        }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
      if (action === "files" && req.method === "GET") return respond(changes.files(oid).then(files => ({ files })));
      if (action === "diff" && req.method === "GET") {
        const filepath = url.searchParams.get("path") ?? "";
        // Both sides are tokenised with the file's own grammar so `+` lines get new-file colours
        // and `-` lines get old-file ones; see diffrows.ts. Anything that cannot be tokenised
        // (binary, too large, unknown language) degrades to the patch on its own, which is what
        // this endpoint always returned before.
        // A tapped fold asks for its own stretch of the unfolded rows (?from=&count=) and gets just
        // those back; the first load sends folds as positions, never the lines they hide, so a
        // one-line change in a big file costs the change and its context, not the file.
        const from = Number(url.searchParams.get("from"));
        const count = Number(url.searchParams.get("count"));
        const slice = Number.isInteger(from) && Number.isInteger(count) && from >= 0 && count > 0
          && url.searchParams.has("from") ? { from, count } : null;
        return respond(
          changes.diff(oid, filepath).then(async (d) => {
            // The patch only rides along when there are no rows to show (a binary or oversized
            // file's one-line note): with rows it is the same file a second time over the wire.
            const base = { binary: !!d.binary, tooLarge: !!d.tooLarge };
            const lang = d.binary || d.tooLarge ? null : languageFor(filepath);
            const coloured = async () => {
              if (!lang || d.before === undefined || d.after === undefined) return null;
              if (d.before.length + d.after.length > MAX_INTERACTIVE_CHARS) return null;
              const [oldLit, newLit] = await Promise.all([highlight(d.before, lang), highlight(d.after, lang)]);
              if (!oldLit && !newLit) return null;
              return {
                oldRows: oldLit ? oldLit.lines.map((l) => l.html) : null,
                newRows: newLit ? newLit.lines.map((l) => l.html) : null,
              };
            };
            // Without colours the rows are still the rows: the patch laid out per line, folded the
            // same way, just with escaped text where the colours would be. Only a binary or oversized
            // file has no rows to show, and its patch is a one-line note that renders as meta.
            const sides = await coloured();
            const { rows, added, removed } = assemble(d.patch, sides?.oldRows ?? null, sides?.newRows ?? null);
            if (slice) return { rows: rows.slice(slice.from, slice.from + slice.count) };
            // Fold long unchanged runs so the viewer opens on the change, not on the whole file.
            const folded = withoutFolded(foldContext(rows, 3, 6));
            return { ...base, lang, rows: folded, ...(folded.length ? {} : { patch: d.patch }), added, removed };
          }),
        );
      }
      if (action === "undo" && req.method === "POST") return respond(changes.undo(oid));
      if (action === "restore" && req.method === "POST") return respond(changes.restore(oid));
    }

    // Undo the newest change of any kind (undoing an undo redoes it). Also used by the native "Recover" menu.
    if (url.pathname === "/api/changes/undo-latest" && req.method === "POST") {
      return changes.undoLatest()
        .then(result => { broadcast("changes", {}); return Response.json(result); })
        .catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    // Attachments from the composer's file picker. The Android picker hands the WebView a
    // content:// URI, so the bytes can be read without any storage permission; the app then
    // writes them itself, which is the only kind of file it can read back from shared
    // storage (other apps' files are EACCES). uploads/ is gitignored, so screenshots never
    // end up in a checkpoint. The returned path is absolute: the agent's working directory is its
    // own session workspace, not the app tree.
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const requested = (url.searchParams.get("name") || "attachment").replace(/[^\w.\- ]+/g, "_").trim().slice(-80);
      return req.arrayBuffer().then(async buf => {
        if (!buf.byteLength) return Response.json({ error: "Empty upload" }, { status: 400 });
        if (buf.byteLength > 24 * 1024 * 1024) return Response.json({ error: "File is larger than 24 MB" }, { status: 413 });
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const file = join(UPLOADS_DIR, `${Date.now()}-${randomUUID()}-${requested || "attachment"}`);
        await Bun.write(file, buf);
        return Response.json({ path: file, size: buf.byteLength });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/files/write" && req.method === "POST") {
      return req.json().then((body: { path: string; content: string }) => {
        if (!body.path || body.content === undefined) {
          return Response.json({ error: "Path and content are required" }, { status: 400 });
        }
        const targetPath = join(APP_DIR, body.path);
        writeFileSync(targetPath, body.content, "utf-8");
        return Response.json({ success: true, path: targetPath });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/files/list" && req.method === "GET") {
      const relPath = url.searchParams.get("dir") || "www";
      const targetDir = join(APP_DIR, relPath);
      if (!existsSync(targetDir)) return Response.json({ files: [] });

      const files = readdirSync(targetDir).map(file => {
        const st = statSync(join(targetDir, file));
        return { name: file, isDirectory: st.isDirectory(), size: st.size };
      });
      return Response.json({ dir: relPath, files });
    }

    // The Files tab's tree: the whole harness in one request.
    //
    // The file set is deliberately the same one extensions/save-bundle.ts walks, so the tab shows
    // exactly what save_bundle would put in a tarball -- that is the tree a user needs to see to
    // judge a bundle. The skip lists below mirror SKIP_DIRS / SKIP_FILES / SKIP_SUFFIXES there (and
    // changes.ts keeps a third copy in its IGNORE), so keep them in step. Consequences worth knowing:
    // vendor/, fallback/ and .git are absent because they are never bundled, and so are auth.json and
    // the sqlite session databases; credentials and conversation history are never readable here.
    if (url.pathname === "/api/files/tree" && req.method === "GET") {
      const shipped = (() => {
        try {
          return JSON.parse(readFileSync(join(APP_DIR, ".shipped_manifest.json"), "utf-8")) as Record<string, string>;
        } catch {
          return {};
        }
      })();

      const isSkipped = (name: string) =>
        TREE_SKIP_FILES.has(name) || TREE_SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));

      // Counted as we walk rather than derived afterwards: the summary line is the only thing that
      // reads these, and re-scanning the finished tree to total them would walk it twice.
      // COUNT_KEY maps each status to its counter field -- the two are spelled differently
      // ("not-shipped" vs notShipped), so indexing counts[status] would silently create a
      // "not-shipped" key and leave the real counter at zero.
      const COUNT_KEY = { modified: "modified", "not-shipped": "notShipped", unchanged: "unchanged" } as const;
      const counts = { files: 0, modified: 0, notShipped: 0, unchanged: 0, totalBytes: 0 };

      type TreeNode = {
        name: string;
        path: string;
        dir: boolean;
        size: number;
        mtime: number;
        status: "modified" | "not-shipped" | "unchanged";
        children?: TreeNode[];
      };

      // withFileTypes keeps symlinks out of the recursion (entry.isDirectory() is false for a link),
      // so a self-referential link cannot spin this into an infinite walk.
      const walk = (rel: string): TreeNode[] => {
        const abs = rel ? join(APP_DIR, rel) : APP_DIR;
        let entries;
        try {
          entries = readdirSync(abs, { withFileTypes: true });
        } catch {
          return [];
        }
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue;
          if (!entry.isDirectory() && isSkipped(entry.name)) continue;
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          let size = 0;
          let mtime = 0;
          try {
            const st = statSync(join(APP_DIR, path));
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            continue; // vanished mid-walk (the agent rewrites files constantly)
          }
          const baseline = shipped[path];
          const node: TreeNode = {
            name: entry.name,
            path,
            dir: entry.isDirectory(),
            size,
            mtime,
            status:
              baseline === undefined ? "not-shipped" : baseline === sha256Hex(readFileSync(join(APP_DIR, path))) ? "unchanged" : "modified",
          };
          if (entry.isDirectory()) {
            node.children = walk(path);
          } else {
            counts[COUNT_KEY[node.status]]++;
            counts.files++;
            counts.totalBytes += size;
          }
          nodes.push(node);
        }
        // Folders before files, then case-insensitive name order: matches how a file tree reads.
        return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
      };

      const tree = walk("");

      // Shipped files that are gone from disk. save_bundle reports these in MANIFEST.json instead of
      // archiving them; showing them here keeps the two views honest about what was deleted.
      const present = new Set<string>();
      const markPresent = (nodes: TreeNode[]) => {
        for (const node of nodes) {
          present.add(node.path);
          if (node.children) markPresent(node.children);
        }
      };
      markPresent(tree);
      const deleted = Object.keys(shipped)
        .filter((path) => !present.has(path) && !TREE_SKIP_DIRS.has(path.split("/")[0]) && !isSkipped(path))
        .sort();

      return Response.json({
        tree,
        deleted,
        counts,
        excluded: {
          dirs: [...TREE_SKIP_DIRS],
          files: [...TREE_SKIP_FILES],
          suffixes: TREE_SKIP_SUFFIXES,
        },
      });
    }

    // Export a bundle without asking the agent: the Files tab's "Export bundle" button.
    //
    // Same bundles.ts writeBundle the save_bundle tool calls, on purpose -- one implementation, so
    // what the tab shows and what the tarball holds stay the same thing. The name is optional and
    // arrives in the query string (a GET-shaped request needs no body and no CSRF dance); an empty
    // or missing one falls back to the tool's default prefix.
    if (url.pathname === "/api/files/bundle" && req.method === "POST") {
      return writeBundle(url.searchParams.get("name") || undefined)
        .then(result => Response.json({ ok: true, ...result }))
        .catch(err => Response.json({ error: String(err?.message || err) }, { status: 500 }));
    }

    // --- Artifacts: browse and serve the files in a session's own workspace ---
    //
    // /api/workspace/tree?session=<id> lists the workspace (the current session when omitted).
    // /workspace/<session id>/<path> serves a file raw with a guessed content type, so an HTML
    // artifact's relative CSS/JS/images resolve against it. The Content-Security-Policy `sandbox`
    // header gives every served file an opaque origin (scripts may run, but cannot reach the app's
    // own API or storage), including if someone navigates straight to the URL. Paths are resolved
    // through realpath and must stay inside the workspace, so a symlink cannot lead out of it.
    const workspaceFor = (raw: string | null) => {
      const row = raw ? sessions.get(Number(raw)) : current;
      return row ? { row, dir: workspaceDir(row.conversationId) } : null;
    };
    const insideWorkspace = (dir: string, rel: string) => {
      const target = resolve(dir, rel);
      if (target !== dir && !target.startsWith(dir + "/")) return null;
      try {
        const real = realpathSync(target);
        const realDir = realpathSync(dir);
        if (real !== realDir && !real.startsWith(realDir + "/")) return null;
        return real;
      } catch {
        return null;
      }
    };

    if (url.pathname === "/api/workspace/tree" && req.method === "GET") {
      const ws = workspaceFor(url.searchParams.get("session"));
      if (!ws) return Response.json({ error: "No such session" }, { status: 404 });
      type Node = { name: string; path: string; dir: boolean; size: number; mtime: number; children?: Node[] };
      let count = 0;
      let truncated = false;
      const walk = (abs: string, rel: string, depth: number): Node[] => {
        let entries;
        try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return []; }
        const out: Node[] = [];
        for (const entry of entries) {
          if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue;
          if (count >= 3000) { truncated = true; break; }
          count++;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childAbs = join(abs, entry.name);
          let st;
          try { st = statSync(childAbs); } catch { continue; }
          if (st.isDirectory()) {
            out.push({ name: entry.name, path: childRel, dir: true, size: 0, mtime: st.mtimeMs, children: depth < 8 ? walk(childAbs, childRel, depth + 1) : [] });
          } else {
            out.push({ name: entry.name, path: childRel, dir: false, size: st.size, mtime: st.mtimeMs });
          }
        }
        return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      };
      const tree = existsSync(ws.dir) ? walk(ws.dir, "", 0) : [];
      return Response.json({ session: ws.row.id, title: ws.row.title, tree, truncated });
    }

    // Markdown from the workspace, rendered to HTML. Same renderer the chat uses, so a README looks
    // like a message. Only the body is returned: the Artifacts screen wraps it in a sandboxed iframe
    // with its own stylesheet, which keeps raw HTML in the file (Bun's renderer passes it through)
    // out of the app's own origin.
    if (url.pathname === "/api/workspace/markdown" && req.method === "GET") {
      const ws = workspaceFor(url.searchParams.get("session"));
      if (!ws) return Response.json({ error: "No such session" }, { status: 404 });
      const real = insideWorkspace(ws.dir, url.searchParams.get("path") || "");
      if (!real || !statSync(real).isFile()) return Response.json({ error: "Not found" }, { status: 404 });
      const size = statSync(real).size;
      if (size > MAX_READ_BYTES) {
        return Response.json({ error: `Too large to preview (${(size / 1024).toFixed(0)} KB)`, size });
      }
      const buffer = readFileSync(real);
      if (buffer.subarray(0, 4096).includes(0)) return Response.json({ error: "Binary file, no preview" }, { status: 415 });
      const html = renderMarkdown(buffer.toString("utf-8"));
      return Response.json({ path: url.searchParams.get("path"), size, html });
    }

    // Coloured version of one workspace file, for the Files screen's source viewer. Same guards as
    // the markdown route above, and the same contract as /api/files/read: `html` is absent when the
    // language is unknown or tokenising failed, and the client falls back to the plain text it
    // already has. Returns a promise rather than awaiting inline, like that route, because the
    // fetch handler is sync (see the WebSocket upgrade branch).
    if (url.pathname === "/api/workspace/highlight" && req.method === "GET") {
      const requested = url.searchParams.get("path") || "";
      const ws = workspaceFor(url.searchParams.get("session"));
      if (!ws) return Response.json({ error: "No such session" }, { status: 404 });
      const real = insideWorkspace(ws.dir, requested);
      if (!real || !statSync(real).isFile()) return Response.json({ error: "Not found" }, { status: 404 });
      const size = statSync(real).size;
      if (size > MAX_READ_BYTES) {
        return Response.json({ error: `Too large to preview (${(size / 1024).toFixed(0)} KB)`, size });
      }
      const buffer = readFileSync(real);
      if (buffer.subarray(0, 4096).includes(0)) return Response.json({ error: "Binary file, no preview" }, { status: 415 });
      const content = buffer.toString("utf-8");
      const base = { path: requested, size, content };
      if (size > MAX_HIGHLIGHT_BYTES) return Response.json({ ...base, lang: null });
      return highlightPath(content, requested).then(
        (lit) =>
          Response.json({
            ...base,
            lang: lit?.lang ?? null,
            rows: lit ? lit.lines.map((l) => l.html) : undefined,
          }),
        () => Response.json({ ...base, lang: null }),
      );
    }

    if (url.pathname.startsWith("/workspace/") && (req.method === "GET" || req.method === "HEAD")) {
      const [, , sid, ...parts] = url.pathname.split("/");
      const ws = workspaceFor(sid);
      if (!ws) return new Response("No such session", { status: 404 });
      let rel = "";
      try { rel = parts.map(decodeURIComponent).join("/"); } catch { return new Response("Bad path", { status: 400 }); }
      let real = insideWorkspace(ws.dir, rel);
      if (real && statSync(real).isDirectory()) real = insideWorkspace(ws.dir, join(rel, "index.html"));
      if (!real || !statSync(real).isFile()) return new Response("Not found", { status: 404 });
      const headers = {
        "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals allow-popups",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (/\.html?$/i.test(real)) {
        // The preview iframe has an opaque origin, so the app cannot see inside it. A tiny script injected
        // ahead of the page's own forwards uncaught errors (and console.error) to the Artifacts screen, which
        // shows them in a scrollable, copyable panel instead of whatever the page manages to draw.
        const html = readFileSync(real, "utf-8");
        const hook = `<script>(function(){function send(m){try{parent.postMessage({pidroidArtifactError:String(m).slice(0,20000)},"*")}catch(e){}}` +
          `addEventListener("error",function(e){send((e.error&&e.error.stack)||(e.message+(e.filename?"\\n  at "+e.filename+":"+e.lineno+":"+e.colno:"")))});` +
          `addEventListener("unhandledrejection",function(e){var r=e.reason;send("Unhandled rejection: "+((r&&r.stack)||r))});` +
          `var ce=console.error;console.error=function(){send(Array.prototype.map.call(arguments,function(a){return a&&a.stack||(typeof a==="object"?JSON.stringify(a):String(a))}).join(" "));return ce.apply(console,arguments)};})()</script>`;
        const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + hook) : hook + html;
        return new Response(injected, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(Bun.file(real), { headers });
    }

    // View one file from the tree. Guarded: the path must stay inside APP_DIR once resolved, and the
    // file must be small and text-ish -- this feeds a <pre>, and a 9 MB sqlite page or a PNG would
    // only stall the WebView. Skipped files stay unreadable here as well as unbundleable.
    if (url.pathname === "/api/files/read" && req.method === "GET") {
      const requested = url.searchParams.get("path") || "";
      const target = resolve(APP_DIR, requested);
      if (target !== APP_DIR && !target.startsWith(APP_DIR + "/")) {
        return Response.json({ error: "Path escapes the app directory" }, { status: 400 });
      }
      const name = target.slice(APP_DIR.length + 1);
      if (name && (TREE_SKIP_FILES.has(target.split("/").pop()!) || TREE_SKIP_SUFFIXES.some((s) => name.endsWith(s)))) {
        return Response.json({ error: "This file is never included in a bundle" }, { status: 403 });
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        return Response.json({ error: "Not a file" }, { status: 404 });
      }
      const size = statSync(target).size;
      if (size > MAX_READ_BYTES) {
        return Response.json({ error: `Too large to preview (${(size / 1024).toFixed(0)} KB)`, path: name, size });
      }
      const buffer = readFileSync(target);
      // A NUL byte in the first block is the cheap binary test; the extension list is what actually
      // matters, and an .svg or .ts never contains one.
      if (buffer.subarray(0, 4096).includes(0)) {
        return Response.json({ error: "Binary file, no preview", path: name, size });
      }
      const content = buffer.toString("utf-8");
      // Syntax highlighting rides along with the text. It is decoration, so every failure mode
      // here just omits `html` and the client renders the plain `content` it always had. Chained
      // rather than awaited: this handler is sync, because the WebSocket upgrade branch above
      // returns a bare `undefined` to signal success, which an async handler would turn into a
      // promise and change what Bun sees.
      const base = { path: name, size, content };
      if (size > MAX_HIGHLIGHT_BYTES) return Response.json({ ...base, lang: null });
      return highlightPath(content, name).then(
        (lit) =>
          Response.json({
            ...base,
            lang: lit?.lang ?? null,
            // One already-escaped HTML string per line, so the client can build a gutter without
            // re-splitting a blob (and without JSON-quoting every token again on the way).
            rows: lit ? lit.lines.map((l) => l.html) : undefined,
          }),
        () => Response.json({ ...base, lang: null }),
      );
    }

    // Static frontend files from www/
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = join(WWW_DIR, filePath);

    if (existsSync(fullPath)) {
      const file = Bun.file(fullPath);
      // The agent edits these files itself, so they must revalidate; but an unchanged file answers
      // 304 with no body instead of being re-read and re-sent on every page load.
      const etag = `"${file.lastModified.toString(36)}-${file.size.toString(36)}"`;
      // Fonts are the exception. They are bundled and never edited in place, so revalidating them on
      // every use buys nothing -- and "no-cache" actively hurt them: the WebView re-fetched each face
      // on every paint and, when that revalidation came back as a bodyless 304, dropped the face and
      // fell through to the next family in the stack. That read as "the font appears, then something
      // replaces it". A long immutable max-age lets the font sit in the cache untouched; the ?v=
      // cache-bust on the stylesheet is what picks up a new build.
      const isFont = /\.(woff2?|ttf|otf|eot)$/i.test(filePath);
      const headers = isFont
        ? { ETag: etag, "Cache-Control": "public, max-age=31536000, immutable" }
        : { ETag: etag, "Cache-Control": "no-cache" };
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(file, { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      hiddenClients.delete(ws); // a fresh connection reports its own visibility in a moment
      ws.send(JSON.stringify({ event: "connected", payload: { version: Bun.version, port: PORT } }));
      ws.send(JSON.stringify({ event: "agent_view", payload: chatPayload(), timestamp: Date.now() }));
    },
    message(ws, message) {
      try {
        const data = JSON.parse(String(message));
        if (data.type === "ping") {
          ws.send(JSON.stringify({ event: "pong" }));
        } else if (data.type === "resync") {
          // The page missed an update (its copy of the live partial is not the one deltas build on).
          ws.send(JSON.stringify({ event: "agent_view", payload: chatPayload(), timestamp: Date.now() }));
        } else if (data.type === "visible") {
          // The page says when it goes to the background, which is exactly when a finished run is
          // worth a notification (see notifyRunFinished).
          if (data.visible === false) hiddenClients.add(ws);
          else hiddenClients.delete(ws);
        }
      } catch {}
    },
    close(ws) {
      clients.delete(ws);
      hiddenClients.delete(ws);
    }
  }
});

console.log(`[pidroid] HTTP & WebSocket Server running at http://127.0.0.1:${server.port}`);
