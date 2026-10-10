import { Database } from "bun:sqlite";
import { join, dirname, resolve, extname, sep, basename } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, cpSync, rmSync, mkdirSync, realpathSync } from "fs";
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
import { showTool } from "./artifacts.ts";
import { assemble, foldContext, withoutFolded } from "./diffrows.ts";
import { fenceLanguage, highlight, highlightPath, languageFor, MAX_INTERACTIVE_CHARS, warm as warmHighlighter } from "./highlight.ts";
import { ExtensionLoader, writeExtensionsTsconfig, type ReloadResult } from "./extensions.ts";
import { APP_DIR, BUILTIN_EXTENSIONS_DIR, DATA_DIR, SKILLS_DIR, USER_EXTENSIONS_DIR, WORKSPACES_DIR } from "./paths.ts";
import { Machines, type MachineRow } from "./machines.ts";
import { copyWorkspaceTree } from "./workspace-copy.ts";
import { DEFAULT_TITLE, Sessions, type SessionRow } from "./sessions.ts";
import { discoverSkills, expandSkillCommand, renderSkillsPrompt } from "./skills.ts";
import { ChatViewBuilder, clampLevel, liveDelta, renderMarkdown, supportedLevels, MODEL_CHANGE_ENTRY_KIND, THINKING_CHANGE_ENTRY_KIND, type ChatView } from "./chatview.ts";
import { Timings } from "./timings.ts";

const PORT = Number(process.env.PORT) || 8765;
/** The web UI, served from the read-only bundle. */
const WWW_DIR = join(APP_DIR, "www");
const DB_PATH = join(DATA_DIR, "pidroid.sqlite");
const ModelChangeEntry = defineEntry(MODEL_CHANGE_ENTRY_KIND);
const ThinkingChangeEntry = defineEntry(THINKING_CHANGE_ENTRY_KIND);

/**
 * Uploaded attachments. Private state, so they live in the data directory and survive app updates.
 */
const UPLOADS_DIR = join(DATA_DIR, "uploads");
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
function agentInputContent(
  text: string,
  attachments: AgentImageAttachment[] = [],
  legacyImageText = text,
): { content: AgentInputContent; error?: string } {
  let uploadRoot: string;
  try {
    uploadRoot = realpathSync(UPLOADS_DIR);
  } catch {
    return attachments.length ? { content: text, error: "The upload directory is unavailable; reattach the image and try again." } : { content: text };
  }

  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const uploadPrefix = resolve(UPLOADS_DIR) + sep;

  const addImage = (candidate: string, explicit = false): string | undefined => {
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
      seen.add(file);
      totalBytes += stat.size;
      return undefined;
    } catch {
      return explicit ? `Could not read image attachment: ${candidate}` : undefined;
    }
  };

  for (const attachment of attachments) {
    if (!attachment || typeof attachment.path !== "string") return { content: text, error: "Invalid image attachment." };
    const error = addImage(attachment.path.trim(), true);
    if (error) return { content: text, error };
  }

  // Keep accepting absolute upload paths inserted by older clients or pasted into the composer.
  for (const line of legacyImageText.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith(uploadPrefix)) continue;
    const error = addImage(candidate);
    if (error) return { content: text, error };
  }

  if (!images.length) return { content: text };
  // The message goes to the model exactly as typed: the images ride along as image blocks and
  // nothing is appended to the text, so what the user wrote is what the model reads.
  return text ? { content: [{ type: "text", text }, ...images] } : { content: images };
}

/* ---------- file tree (Files tab) ----------
   A read-only view of the app's code. Dependencies and VCS internals are left out: they are noise, not code. */
const TREE_SKIP_DIRS = new Set([".git", "node_modules", "vendor", ".bun", ".tmp"]);

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
mkdirSync(DATA_DIR, { recursive: true });
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

// --- pi-durable agent ---------------------------------------------------
const context = BACKGROUND_CONTEXT;
const AGENT_DB_PATH = join(DATA_DIR, "pidroid-agent.sqlite");

/**
 * pi-ai's default models store is in-memory, so a refreshed catalog dies with
 * the process and every boot falls back to the provider's bundled snapshot.
 * That is how Command Code kept losing models the API had already published
 * (the snapshot is a snapshot: DeepSeek V4.1 Flash was missing from it).
 * Persisting the published catalogs makes a refresh stick across restarts.
 */
const MODELS_STORE_PATH = join(DATA_DIR, "pidroid-models.json");

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
const credentials = new FileCredentialStore(join(DATA_DIR, "auth.json"));
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
  if (/\b(server\.js|vendor\/)/.test(command)) return `${APP_DIR}/vendor is generated minified code; reading it is useless. Read server.ts, auth.ts, chatview.ts, sessions.ts, extensions.ts and providers/ in $PIDROID_APP_DIR instead.`;
  if (writesIntoAppDir(command)) return `${APP_DIR} is the app's read-only code, replaced by updates. Write user extensions to $PIDROID_DATA_DIR/extensions and everything else to your workspace.`;
  return undefined;
}

/** The app directory as a shell command would spell it. */
const APP_DIR_SPELLINGS = [APP_DIR, "$PIDROID_APP_DIR", "${PIDROID_APP_DIR}"];
/** Best-effort: a redirect (not 2>&1), or a command that changes files. A command that names the app and does one of these is refused. */
const WRITE_COMMAND = /(?:^|[^\d&>])>{1,2}(?!&)|\b(?:rm|mv|cp|tee|touch|mkdir|rmdir|chmod|chown|truncate|ln|install|rsync|dd|patch)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i/;

function writesIntoAppDir(command: string): boolean {
  return APP_DIR_SPELLINGS.some((spelling) => command.includes(spelling)) && WRITE_COMMAND.test(command);
}

/** The real location of a path, following symlinks through its longest existing prefix. */
function realLocation(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  try {
    return join(realpathSync(existing), ...missing);
  } catch {
    return path;
  }
}

/**
 * Whether a write/edit path lands inside the app's code. A relative path is resolved against a session workspace,
 * which sits at the same depth under WORKSPACES_DIR for every session, so `..` segments resolve the way they do there.
 */
function isInsideAppDir(path: string): boolean {
  const target = resolve(join(WORKSPACES_DIR, "0"), path);
  const appReal = realLocation(APP_DIR);
  return [target, realLocation(target)].some((p) => p === APP_DIR || p === appReal || p.startsWith(APP_DIR + sep) || p.startsWith(appReal + sep));
}

/** Exit code the Android app treats as "restart me now" (anything else counts as a crash). */
const PLANNED_EXIT_CODE = 75;

/** Exit so the app relaunches this server; the flag tells the next boot that unfinished runs should resume, not abort. */
function scheduleRestart(delayMs: number) {
  setState("planned_restart", String(Date.now()));
  console.log(`[pidroid] planned restart in ${delayMs}ms`);
  setTimeout(() => process.exit(PLANNED_EXIT_CODE), delayMs);
}

// A user-requested stop exits Bun with code 0. The Android host currently treats other exit codes as crashes;
// a host-level stop signal would be needed to avoid that.
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

/** What a reload did, one line per extension, for the agent to read. */
function reloadSummary(result: ReloadResult): string {
  const lines = [
    ...result.loaded.map((l) => `loaded ${l}`),
    ...result.removed.map((r) => `removed ${r}`),
    ...Object.entries(result.errors).map(([key, error]) => `ERROR ${key}: ${error}`),
  ];
  return lines.join("\n") || "no extension files";
}

const reloadExtensionsTool = defineTool({
  name: "reload_extensions",
  description:
    "Re-import every extension file (built-in and user) and hot-swap the extensions (tools, prompt sections, hooks) without restarting. " +
    "Running work finishes on the old code; the next tool call or request uses the new one. Reports import errors per file.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    api.output(reloadSummary(await loader.reload()));
    return {};
  },
});

const listExtensionsTool = defineTool({
  name: "list_extensions",
  description:
    "List the extensions: built-in ones (shipped with the app, read-only) and your user extensions in $PIDROID_DATA_DIR/extensions, " +
    "each with its key (builtin:<file> or user:<file>) and whether it is enabled.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    const states = loader.list();
    api.output(states.length ? states.map((s) => `${s.key}  ${s.name}  ${s.enabled ? "enabled" : "disabled"}`).join("\n") : "No extensions.");
    return {};
  },
});

const removeExtensionTool = defineTool({
  name: "remove_extension",
  description:
    "Delete one of your user extensions (a file in $PIDROID_DATA_DIR/extensions) and unload it. Built-in extensions cannot be removed. " +
    "Give the file name, e.g. weather.ts.",
  parameters: Type.Object({ file: Type.String({ description: "File name in $PIDROID_DATA_DIR/extensions, e.g. weather.ts" }) }),
  replay: "safe",
  execute: async (args, api) => {
    const key = `user:${args.file.replace(/^user:/, "")}`;
    const removed = loader.removeUser(key);
    setExtensionEnabled(key, true); // forget any switch-off for a file that no longer exists
    api.output(`Removed user:${removed}.\n${reloadSummary(await loader.reload())}`);
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

const Pidroid = defineExtension({
  name: "pidroid",
  tools: [reloadExtensionsTool, listExtensionsTool, removeExtensionTool, showTool],
  sections: [
    section(
      "pidroid",
      // `input.conversationId` is passed by the runtime (pi-durable's renderSections),
      // so the workspace path below is the real one for this conversation rather than
      // a placeholder the reader has to guess at. workspaceDir() is the same helper
      // used to create the directory, so the two cannot drift apart.
      (input) =>
        "You are the agent embedded in the Pidroid Android app, running on Bun inside the app's own process sandbox. " +
        "Your working directory is this session's own workspace ($PIDROID_WORKSPACE): scratch files, scripts and experiments belong there and are yours alone. " +
        "It is NOT version controlled, and nothing in it is backed up. " +
        "A session's tools can also run on one of the user's machines over SSH (the Machines feature, machines.ts, over pi-env): its bash, file reads and writes and everything shell-shaped then happen on that machine, in the session's own folder there (<machine folder>/session-<conversationId>), while the model, storage and credentials stay on the phone. " +
        "A session's machine can be changed later from its session menu while it is idle; that changes where future tools run, not its transcript or model. The user can optionally copy the current workspace to the new location (replacing the destination workspace, up to 64 MiB; symbolic links cannot be copied). A session without a machine runs on the phone exactly as described here. " +
        "In a session on a machine, the app code, skills, uploads and shell notes below are the phone's: that session sees the machine's filesystem instead, with the machine's own utilities and toolchain (no toybox, no bundled GNU grep), so paths and build advice here only hold for sessions running on the phone. " +
        "Host keys are scanned and confirmed by the user in the Machines tab before a machine will connect at all, so never try to add, trust or SSH to a machine yourself. " +
        "The app's code is $PIDROID_APP_DIR (the server, the web UI in www/, and the built-in extensions). It is READ-ONLY: you cannot change it, and the app replaces it automatically with each update, so do not try to patch it. " +
        "Writable places: your workspace ($PIDROID_WORKSPACE); user extensions in $PIDROID_DATA_DIR/extensions; shared Agent Skills in $PIDROID_SKILLS, one directory per skill with a SKILL.md file, shared across sessions and kept across app updates. " +
        "To give yourself a new tool, prompt section or hook, write a TypeScript file in $PIDROID_DATA_DIR/extensions with a default export of defineExtension({ name, tools, sections, hooks }) from @earendil-works/pi-durable (the built-in extensions in $PIDROID_APP_DIR/extensions are read-only examples). " +
        "Imports are limited to the packages mapped in $PIDROID_DATA_DIR/extensions/tsconfig.json (the same ones the app's own code uses); anything else will not resolve. " +
        "Then call reload_extensions: no restart is needed. list_extensions shows what is installed, and remove_extension deletes one of your files. A user extension with the same name as a built-in one replaces it. " +
        "vendor/ holds prebuilt dependencies and is not editable; only the packages mapped in tsconfig.json can be imported. " +
        "Files the user attaches from the phone are saved in $PIDROID_UPLOADS. The read tool also supports image files and sends them as image input to vision-capable models. If a file path is shown in the message, it is absolute and should be used as given. " +
        "The UI is black (AMOLED) themed; keep it that way. " +
        "The Android shell around the web view (Kotlin) is not part of your sandbox and cannot be edited from here; if a feature needs it, say so instead of searching the device. " +
        "The shell is real bash on an Android sandbox. grep/egrep/fgrep are GNU grep 3.12, bundled and first on PATH; every other coreutil is toybox, so GNU-only flags are missing and error out loudly (cat takes only -etuv, head has no negative -n). Prefer short portable invocations; note that grep -r descends into .git and node_modules, so pass --exclude-dir. " +
        "On PATH: bun (the full CLI: bun run / test / build / install / add), bunx, ssh and ssh-keygen. Use bun to try out your own code: run scripts and `bun test` in your workspace, or check a user extension in isolation. " +
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
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        if (call.name === "bash") {
          const reason = blockedBashReason(String(args.command ?? ""));
          return reason ? { block: reason } : undefined;
        }
        // The write and edit tools take the path as `path`; file_path is accepted too, in case a tool spells it that way.
        if (call.name === "write" || call.name === "edit") {
          const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
          if (path && isInsideAppDir(path)) {
            return { block: `${path} is inside the app's read-only code ($PIDROID_APP_DIR). Write user extensions to $PIDROID_DATA_DIR/extensions and everything else to your workspace.` };
          }
        }
        return undefined;
      },
    }),
  ],
});

const registry = createRegistry();
registry.install(ImageAwareCodingTools);
registry.install(Pidroid);
registry.install(WebTools);
// Built-in extensions first, then the user's own: a user file with the same name replaces the built-in one.
writeExtensionsTsconfig(APP_DIR, USER_EXTENSIONS_DIR);
const loader = new ExtensionLoader(
  registry,
  [
    { origin: "builtin", dir: BUILTIN_EXTENSIONS_DIR },
    { origin: "user", dir: USER_EXTENSIONS_DIR },
  ],
  key => !disabledExtensions().has(key),
);
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
    env: async ({ conversationId, cwd }, envContext) => {
      // A session on a machine runs its tools there (machines.ts); the phone only runs the model and the app.
      const row = sessions.byConversation(Number(conversationId));
      if (row?.machineId != null) {
        const machine = machines.get(row.machineId);
        if (!machine) throw new Error("This session's machine was removed");
        return machines.environment(machine, Number(conversationId), envContext);
      }
      // Each conversation runs in its own workspace; a conversation without a stored cwd (a session
      // created before workspaces existed, and only for the turn or two before the migration runs)
      // still gets a directory of its own rather than sharing one.
      const dir = cwd ? join(cwd) : workspaceDir(Number(conversationId));
      mkdirSync(dir, { recursive: true });
      // Hand the shell a valid $PWD. Without it bash falls back to its own getcwd(), which walks up through parent
      // directories; the app sandbox can't list /data/user/0 or /data, so every command printed
      // "shell-init: error retrieving current directory: getcwd: cannot access parent directories".
      return new NodeExecutionEnv({
        cwd: dir,
        shellEnv: { PWD: dir, PIDROID_WORKSPACE: dir, PIDROID_APP_DIR: APP_DIR, PIDROID_DATA_DIR: DATA_DIR, PIDROID_UPLOADS: UPLOADS_DIR, PIDROID_SKILLS: SKILLS_DIR },
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

// Which extensions the user has switched off in Settings, by key ("builtin:<file>" or "user:<file>"). Read fresh on
// every reload rather than captured once, so a toggle applies to the next hot-swap without a restart. A plain file name
// was stored before user extensions existed, and meant a built-in one, so it is read as one.
const DISABLED_EXTENSIONS_KEY = "extensions.disabled";
function disabledExtensions(): Set<string> {
  try {
    const parsed = JSON.parse(getState(DISABLED_EXTENSIONS_KEY) ?? "[]");
    const keys = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
    return new Set(keys.map((k) => (k.includes(":") ? k : `builtin:${k}`)));
  } catch {
    return new Set();
  }
}
function setExtensionEnabled(key: string, enabled: boolean) {
  const disabled = disabledExtensions();
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  setState(DISABLED_EXTENSIONS_KEY, JSON.stringify([...disabled]));
}

// --- Sessions: any number of pi-durable conversations, one shown at a time ---------------------------------
const sessions = new Sessions(db);
const machines = new Machines(db, join(DATA_DIR, "machines"));
/** Sessions held while their workspace is being copied and their execution environment is changed. */
const switchingConversations = new Set<number>();
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

/**
 * Title model used until the user picks their own. Naming a session is a one-shot request, not a
 * multi-turn agent turn, and on OpenCode's anonymous free tier that matters: the Muse models are
 * only served inside a real editor turn (they carry the full tool set + conversation the free
 * tier fingerprints for), so a bare "write a title" call is rejected with 403 FreeTierError
 * "can only be used from within OpenCode". space-bunny-free is the free model Zen answers for a
 * minimal one-shot request from the anonymous tier, so that is what defaults here. Keeps the
 * handful of titling tokens off the run model regardless. "None" in the chooser turns model
 * titles off again; that choice is remembered as the sentinel below.
 */
const DEFAULT_TITLE_MODEL = "opencode/space-bunny-free";
const TITLE_MODEL_OFF = "none";

/** Parse a "<provider>/<id>" key, or undefined when the catalogue no longer carries it. */
function resolveTitleModel(key: string): { key: string; provider: string; modelId: string } | undefined {
  const [provider, ...rest] = key.split("/");
  const modelId = rest.join("/");
  return provider && modelId && models.getModel(provider, modelId) ? { key, provider, modelId } : undefined;
}

/** True when the title model in effect was the user's own pick -- not the built-in default. */
function titleModelChosen(): boolean {
  const key = getState("title_model")?.trim();
  return !!key && key !== TITLE_MODEL_OFF;
}

/** The model titles are written with: the user's pick, else the built-in default while it is
    still in the catalogue, else none at all (and titles then come from the opening message). */
function titleModelPreference(): { key: string; provider: string; modelId: string } | undefined {
  const key = getState("title_model")?.trim();
  if (key === TITLE_MODEL_OFF) return undefined;
  return resolveTitleModel(key || DEFAULT_TITLE_MODEL);
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

async function createSession(machineId: number | null = null): Promise<SessionRow> {
  // Checked before the conversation exists, so a refused machine leaves nothing behind.
  const machine = machineId == null ? undefined : machines.get(machineId);
  if (machineId != null && !machine) throw new Error("No such machine");
  if (machine && !machine.trusted) throw new Error(`Confirm ${machine.name}'s host key before running sessions on it`);
  const model = pickDefaultModel();
  const thinking = thinkingInfo().current;
  const conv = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model, thinkingLevel: thinking as any } },
    context,
  );
  const row = sessions.create(Number(conv.id), DEFAULT_TITLE, `${model.provider}/${model.modelId}`, thinking, null, null, machine?.id ?? null);
  handles.set(row.conversationId, conv);
  await pointAtWorkspace(row);
  return row;
}

/** The machine a session runs on, or undefined for one that runs on the phone. */
function machineOf(row: SessionRow): MachineRow | undefined {
  if (row.machineId == null) return undefined;
  const machine = machines.get(row.machineId);
  if (!machine) throw new Error("This session's machine was removed");
  return machine;
}

/** Give a session its own working directory (created on demand) and make the agent run there. */
async function pointAtWorkspace(row: SessionRow): Promise<string> {
  const machine = machineOf(row);
  // On a machine the folder is created by the first operation that needs it, not here.
  const dir = machine ? machines.sessionFolder(machine, row.conversationId) : workspaceDir(row.conversationId);
  if (!machine) mkdirSync(dir, { recursive: true });
  const conv = await handleFor(row);
  await conv.configure({ cwd: dir } as any, context);
  return dir;
}

/** Move one idle session's future tool calls to another machine, optionally replacing its workspace with a copy. */
async function changeSessionMachine(
  sessionId: number,
  targetMachineId: number | null,
  copyWorkspace: boolean,
): Promise<{ row: SessionRow; copied?: { bytes: number; files: number } }> {
  const initial = sessions.get(sessionId);
  if (!initial) throw new Error("No such session");
  const conversationId = initial.conversationId;
  if (switchingConversations.has(conversationId)) throw new Error("This session is already changing machines");

  // Take the lock before inspecting the harness. A message that arrives after this point is refused, while a message
  // that won the race before it is reflected either here or in runningConversations below.
  switchingConversations.add(conversationId);
  broadcast("sessions_changed", {});
  try {
    const busy = await busySessions();
    if (busy.has(conversationId) || runningConversations.has(conversationId)) {
      throw new Error("Wait for this session's run to finish before changing machines");
    }

    const row = sessions.get(sessionId);
    if (!row) throw new Error("No such session");
    if (row.machineId === targetMachineId) return { row };

    const sourceMachine = machineOf(row);
    const targetMachine = targetMachineId == null ? undefined : machines.get(targetMachineId);
    if (targetMachineId != null && !targetMachine) throw new Error("No such machine");
    if (targetMachine && !targetMachine.trusted) throw new Error(`Confirm ${targetMachine.name}'s host key before switching to it`);

    const sourceFolder = sourceMachine ? machines.sessionFolder(sourceMachine, conversationId) : workspaceDir(conversationId);
    const targetFolder = targetMachine ? machines.sessionFolder(targetMachine, conversationId) : workspaceDir(conversationId);
    // Preflight the destination before changing the row, so a missing/untrusted machine never strands the session.
    const destinationEnv = targetMachine
      ? await machines.environment(targetMachine, conversationId, context)
      : new NodeExecutionEnv({ cwd: targetFolder });
    if (!targetMachine) mkdirSync(targetFolder, { recursive: true });

    let copied: { bytes: number; files: number } | undefined;
    if (copyWorkspace) {
      const sourceEnv = sourceMachine
        ? await machines.environment(sourceMachine, conversationId, context)
        : new NodeExecutionEnv({ cwd: sourceFolder });
      copied = await copyWorkspaceTree(sourceEnv, sourceFolder, destinationEnv, targetFolder, context);
    }

    const previousMachineId = row.machineId;
    sessions.setMachine(sessionId, targetMachineId);
    const updated = sessions.get(sessionId);
    if (!updated) throw new Error("Session disappeared while changing machines");
    try {
      await pointAtWorkspace(updated);
    } catch (error) {
      sessions.setMachine(sessionId, previousMachineId);
      const restored = sessions.get(sessionId);
      if (restored) {
        if (current.id === sessionId) current = restored;
        await pointAtWorkspace(restored).catch(restoreError => {
          console.warn(`[pidroid] could not restore session ${sessionId}'s workspace after a machine switch failed: ${restoreError}`);
        });
      }
      throw error;
    }

    if (current.id === sessionId) {
      current = updated;
      broadcast("agent_view", chatPayload());
    }
    return { row: updated, copied };
  } finally {
    switchingConversations.delete(conversationId);
    broadcast("sessions_changed", {});
  }
}

/** Copy a session's files on its machine into a branch's folder there. A missing source copies nothing. */
async function copyRemoteWorkspace(machine: MachineRow, fromConversation: number, toConversation: number): Promise<boolean> {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const from = machines.sessionFolder(machine, fromConversation);
  const to = machines.sessionFolder(machine, toConversation);
  const env = await machines.environment(machine, toConversation, context);
  const result = await env.exec(`if [ -d ${quote(from)} ]; then cp -R ${quote(from)}/. ${quote(to)}/; fi`, undefined, context);
  return result.ok && result.value.exitCode === 0;
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
  const branch = sessions.create(Number(child.id), row.title, row.model, row.thinking, row.id, at, row.machineId);
  handles.set(branch.conversationId, child);
  // The copied agent doc carries the parent's cwd, so without this the two sessions would run in one
  // workspace. The child's own conversation id names its directory and cannot collide with the parent's.
  await pointAtWorkspace(branch);
  const machine = machineOf(branch);
  if (machine) {
    // The files are on the machine, so the copy happens there, with the same outcome as a local one.
    const copied = await copyRemoteWorkspace(machine, row.conversationId, branch.conversationId);
    if (!copied) console.warn(`[pidroid] branch of session ${row.id}: workspace on ${machine.name} was not copied`);
    return { branch, copied };
  }
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
// the app's own directory. Point each one at its own directory once; the marker keeps later boots from rewriting
// the doc on every start.
if (getState("workspaces") !== WORKSPACES_DIR) {
  for (const row of sessions.list()) {
    await pointAtWorkspace(row).catch(err => console.warn(`[pidroid] workspace for session ${row.id}: ${err}`));
  }
  setState("workspaces", WORKSPACES_DIR);
  console.log(`[pidroid] sessions work in ${WORKSPACES_DIR}/<session id>`);
}

// A title-model preference pinned to an OpenCode Muse model cannot work: titling is a bare one-shot
// request, and Zen's anonymous free tier only serves the Muse models to a real editor turn, so it
// answers with 403 FreeTierError. Move any such preference to the default (space-bunny-free), which
// the anonymous tier answers for a minimal request. Runs once per affected value; harmless after.
{
  const titleModelKey = getState("title_model");
  if (titleModelKey && /^(opencode\/)?muse-/i.test(titleModelKey)) {
    setState("title_model", DEFAULT_TITLE_MODEL);
    console.log(`[pidroid] title model ${titleModelKey} cannot serve one-shot titles on the free tier; using ${DEFAULT_TITLE_MODEL}`);
  }
}

// Crash-loop guard: a run that keeps killing the process must not be resumed forever. A planned restart (the
// Restart button) is not a crash: its runs resume, and it doesn't count towards the guard. A user stop is also
// intentional, but unfinished runs must be aborted rather than resumed if the host relaunches us.
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
  publishRunningCount();
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
  publishRunningCount();
}

/* ---------- the running count, pushed out to the app ----------
   The foreground-service notification says how many sessions have a run in flight, and this process is
   the only side that sees a run start or end. The app could poll a route for the number, but that wakes
   the phone every few seconds whether or not anything is running; a bridge call per transition leaves an
   idle agent making no calls at all -- the same shape as the "done" notification just below. The count
   is runningConversations, the reconciled view above, so the number in the notification is the same one
   the sidebar shows. */
function publishRunningCount() {
  if (!bridgeAvailable()) return;
  void bridgeCall("agent.setRunningCount", { running: runningConversations.size })
    .catch((err: Error) => console.warn(`[pidroid] running-count push failed: ${err?.message ?? err}`));
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
    for (const conversationId of live) runningConversations.add(conversationId);
    if (live.size) scheduleRunWatch();
    // This process owns the count from here on, zeros included: a process that replaced a crashed agent
    // must publish its own view rather than leave the old process's number on screen.
    publishRunningCount();
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
 * bug in the id that reached here cannot turn a delete into an rm -rf of something else.
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
  if (switchingConversations.has(row.conversationId)) throw new Error("This session is changing machines. Try again when it is finished.");

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
 * Returns the paths actually written. Falls back to the app's data directory if shared storage is not writable
 * (a device where the folder is missing), which still leaves the file somewhere reachable.
 */
function saveTranscript(row: SessionRow, messages: TranscriptMessage[], meta: TranscriptMeta) {
  const files = transcriptFiles(row, messages, meta);
  const dirs = [TRANSCRIPT_DIR, join(DATA_DIR, "exports")];
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
   in and the reason on the way out. The page only shows failures; "started" exists so it can
   name the model in the fix prompt it offers with the failure. */
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
  // The title model when one is in effect -- picked, or the built-in default -- and only
  // when there is none at all ("None" was chosen) the model this session already runs on: a
  // manual "generate" is a deliberate request for a model to think about the name, and that one
  // is already configured, signed in and paid for.
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
        // on "New session" with no word about why. Same rule as below: a default nobody picked
        // failing is not a setting to fix, so it only says so once the model was chosen.
        if (titleModelChosen()) noteTitleStatus(sessionId, "failed", "the model returned an empty title");
        if (titleModelPreference()?.key === preference.key) applyGeneratedTitle(sessionId, messageTitle(firstMessage));
        return;
      }

      // Respect a manual rename, a changed title-model preference, or a deleted session.
      if (titleModelPreference()?.key !== preference.key) return;
      applyGeneratedTitle(sessionId, generated);
    } catch (err) {
      console.warn(`[pidroid] title generation failed for session ${sessionId}:`, err);
      // A default nobody picked failing is not a broken setting to fix -- Zen answers 403 for
      // most of its free ids on the anonymous tier -- so it stays quiet and names the session
      // after its first message, which is what picking None would have done.
      if (titleModelChosen()) noteTitleStatus(sessionId, "failed", err instanceof Error ? err.message : String(err));
      // Better a plain title from the message than a session stuck on "New session".
      if (titleModelPreference()?.key === preference.key) applyGeneratedTitle(sessionId, messageTitle(firstMessage));
    } finally {
      titleGenerationJobs.delete(sessionId);
    }
  })();
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

    if (url.pathname === "/api/chat" && req.method === "POST") {
      return req.json().then(async (body: { message?: string; attachments?: AgentImageAttachment[] }) => {
        const session = current;
        if (switchingConversations.has(session.conversationId)) {
          return Response.json({ error: "This session is changing machines. Wait for it to finish before sending a message." }, { status: 409 });
        }
        const conv = root; // Capture the session before any asynchronous work; a later view switch cannot redirect this request.
        const text = body.message?.trim() ?? "";
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        if (!text && !attachments.length) {
          return Response.json({ error: "Message or image attachment is required" }, { status: 400 });
        }
        // What the user typed is the whole message: attached images travel as image inputs,
        // never as extra text appended to it.
        const visibleText = text;
        const skillExpansion = expandSkillCommand(visibleText);
        if (skillExpansion.error) {
          return Response.json({ error: skillExpansion.error }, { status: 400 });
        }
        // Only the user's original text is eligible for the legacy upload-path shortcut. A skill
        // may mention an upload path as an example, which must stay text rather than attach a file.
        const agentInput = agentInputContent(skillExpansion.content, attachments, visibleText);
        if (agentInput.error) {
          return Response.json({ error: agentInput.error }, { status: 413 });
        }
        // The transcript only needs a stand-in so an image-only message still renders as something.
        const storedText = text || "[image]";

        // Store user message
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("user", storedText);
        broadcast("message", { role: "user", content: storedText });

        let replyText: string;
        if (session.title === DEFAULT_TITLE) scheduleTitleGeneration(session.id, visibleText);
        sessions.touch(session.id);
        noteRunStarted(session.conversationId); // the row switches to "running" until this settles
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
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("assistant", replyText);
        broadcast("message", { role: "assistant", content: replyText });

        return Response.json({ success: true, reply: replyText });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/compact" && req.method === "POST") {
      return req.json().catch(() => ({})).then(async (body: { instructions?: string }) => {
        const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
        if (instructions.length > 4000) {
          return Response.json({ error: "Compaction instructions must be 4,000 characters or fewer." }, { status: 400 });
        }

        const conversation = root; // finish compaction on the session the command was sent to
        try {
          const taskId = await conversation.compact(instructions || undefined, context);
          const settled = await harness.waitForTask(taskId, context);
          const outcome = (settled as any)?.state?.outcome;
          if (outcome?.status !== "completed") {
            const detail = outcome?.error?.message ?? outcome?.error ?? outcome?.reason;
            throw new Error(typeof detail === "string" ? detail : `Compaction did not complete (${outcome?.status ?? "unknown status"}).`);
          }

          const submissionId = outcome.result?.submissionId;
          if (submissionId !== undefined) {
            const submission = await harness.submission(submissionId, context);
            if (!submission) throw new Error("The compaction summary could not be found in the conversation.");
            const placed = await submission.wait(context);
            if (placed.status !== "done") {
              const reason = (placed as any).reason;
              throw new Error(reason === "stale"
                ? "The conversation changed before this summary could be applied. Try /compact again when it is idle."
                : `Compaction summary was not applied (${reason ?? placed.status}).`);
            }
          }
          return Response.json({ success: true, message: "Conversation compacted." });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      const agent = pickDefaultModel();
      const fallback = defaultModel();
      const titleModel = titleModelPreference()?.key ?? "";
      // The chooser marks the built-in default as such: it is in use, but nobody picked it, so
      // None remains a one-tap way back rather than a fight against the default.
      const titleModelDefault = !!titleModel && !titleModelChosen();
      return logins.providers().then(providers => {
        // Usable = signed-in providers, plus the anonymous OpenCode free tier.
        const usable = new Set(providers.filter(p => p.configured).map(p => p.id));
        usable.add("opencode");
        const names = new Map(models.getProviders().map(p => [p.id, p.name ?? p.id]));
        return Response.json({
          current: `${agent.provider}/${agent.modelId}`,
          default: `${fallback.provider}/${fallback.modelId}`,
          titleModel,
          titleModelDefault,
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
        if (!selected || selected === TITLE_MODEL_OFF) {
          // None is a remembered choice, not an empty one: it has to survive the built-in
          // default rather than falling back to it on the next load.
          setState("title_model", TITLE_MODEL_OFF);
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

    // --- Extensions ---
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
      return Response.json({ extensions: loader.list(), parked: loader.parked() });
    }

    if (url.pathname === "/api/extensions/toggle" && req.method === "POST") {
      return req.json()
        .then((body: { key?: string; file?: string; enabled?: boolean }) => {
          // `file` is the older way to name a built-in extension.
          const key = body.key ?? (body.file ? `builtin:${body.file}` : undefined);
          if (!key || !loader.list().some((e) => e.key === key)) throw new Error("No such extension");
          setExtensionEnabled(key, body.enabled !== false);
          return loader.reload();
        })
        .then(reload => Response.json({ success: true, extensions: loader.list(), reload }))
        .catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    // The Restart button in Settings (the app's host restarts the process itself; this is the browser's way).
    if (url.pathname === "/api/restart" && req.method === "POST") {
      scheduleRestart(300);
      return Response.json({ success: true });
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      scheduleStop(500); // leave time for this response and the UI confirmation to reach the WebView
      return Response.json({ success: true, stopping: true });
    }

    // --- Sessions ---
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return busySessions().then(busy => Response.json({
        current: current.id,
        // The machines a new session can run on, for the picker and the sidebar's machine labels.
        machines: machines.list().map(({ id, name, trusted }) => ({ id, name, trusted })),
        // Depth-ordered forest: branches sit under the session they came from.
        sessions: sessions.tree().map(({ row, depth }) => ({
          ...row,
          depth,
          busy: busy.has(row.conversationId),
          switching: switchingConversations.has(row.conversationId),
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
        if (switchingConversations.has(row.conversationId)) throw new Error("This session is changing machines. Try again when it is finished.");
        const at = Number(body.at);
        if (!Number.isSafeInteger(at) || at < 1) throw new Error("No entry to branch at");
        const { branch, copied } = await forkSession(row, at);
        await switchTo(branch.id); // also announces the new session
        return Response.json({ success: true, id: branch.id, copied });
      }).catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      return req.json().catch(() => ({})).then((body: { machineId?: number | null }) => createSession(body.machineId ?? null))
        .then(async row => { await switchTo(row.id); return Response.json({ success: true, id: row.id }); })
        .catch(err => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }));
    }

    // --- Machines: other computers a session can run its tools on (machines.ts) ---
    const machineError = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    if (url.pathname === "/api/machines" && req.method === "GET") {
      return Response.json({ machines: machines.list() });
    }
    if (url.pathname === "/api/machines" && req.method === "POST") {
      return req.json()
        .then(async body => Response.json({ success: true, machine: await machines.add(body) }))
        .catch(machineError);
    }
    const machineRoute = url.pathname.match(/^\/api\/machines\/(\d+)\/(scan|trust|test|delete)$/);
    if (machineRoute && req.method === "POST") {
      const id = Number(machineRoute[1]);
      return req.json().catch(() => ({})).then(async (body: { fingerprint?: string }) => {
        switch (machineRoute[2]) {
          case "scan":
            return Response.json({ success: true, ...(await machines.scan(id)) });
          case "trust":
            await machines.trust(id, String(body.fingerprint ?? ""));
            return Response.json({ success: true, machine: machines.get(id) });
          case "test":
            return Response.json({ success: true, platform: await machines.probe(id) });
          default: {
            // A session that still runs there would lose its tools, so the machine stays until they are gone.
            const inUse = sessions.list().filter(row => row.machineId === id).length;
            if (inUse > 0) throw new Error(`${inUse} session(s) run on this machine. Delete them first.`);
            machines.remove(id);
            return Response.json({ success: true });
          }
        }
      }).catch(machineError);
    }

    const sessionMachineRoute = url.pathname.match(/^\/api\/sessions\/(\d+)\/machine$/);
    if (sessionMachineRoute && req.method === "POST") {
      const id = Number(sessionMachineRoute[1]);
      return req.json().then(async (raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid machine change request");
        const body = raw as { machineId?: unknown; copyWorkspace?: unknown };
        if (!Object.prototype.hasOwnProperty.call(body, "machineId")) throw new Error("Choose where this session should run");
        let machineId: number | null;
        if (body.machineId === null) machineId = null;
        else if (typeof body.machineId === "number" && Number.isSafeInteger(body.machineId) && body.machineId > 0) machineId = body.machineId;
        else throw new Error("Invalid machine choice");
        if (body.copyWorkspace !== undefined && typeof body.copyWorkspace !== "boolean") throw new Error("Invalid workspace-copy choice");
        const result = await changeSessionMachine(id, machineId, body.copyWorkspace === true);
        return Response.json({ success: true, machineId: result.row.machineId, copied: result.copied ?? null });
      }).catch(machineError);
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

    // Attachments from the composer's file picker. The Android picker hands the WebView a
    // content:// URI, so the bytes can be read without any storage permission; the app then
    // writes them itself, which is the only kind of file it can read back from shared
    // storage (other apps' files are EACCES). uploads/ is kept out of the app's code, so screenshots
    // never end up in a bundle. The returned path is absolute: the agent's working directory is its
    // own session workspace, not the app's code.
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

    // The Files tab's tree: the app's code, read-only, in one request. VCS internals and dependencies are left out
    // (TREE_SKIP_DIRS); everything else in the bundle is shown as it is.
    if (url.pathname === "/api/files/tree" && req.method === "GET") {
      type TreeNode = { name: string; path: string; dir: boolean; size: number; mtime: number; children?: TreeNode[] };
      // withFileTypes keeps symlinks out of the recursion (entry.isDirectory() is false for a link),
      // so a self-referential link cannot spin this into an infinite walk.
      const walk = (rel: string): TreeNode[] => {
        let entries;
        try {
          entries = readdirSync(rel ? join(APP_DIR, rel) : APP_DIR, { withFileTypes: true });
        } catch {
          return [];
        }
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.isDirectory() && TREE_SKIP_DIRS.has(entry.name)) continue;
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          let st;
          try {
            st = statSync(join(APP_DIR, path));
          } catch {
            continue; // vanished mid-walk
          }
          const node: TreeNode = { name: entry.name, path, dir: entry.isDirectory(), size: st.size, mtime: st.mtimeMs };
          if (entry.isDirectory()) node.children = walk(path);
          nodes.push(node);
        }
        // Folders before files, then case-insensitive name order: matches how a file tree reads.
        return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
      };
      return Response.json({ tree: walk(""), excluded: [...TREE_SKIP_DIRS] });
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

    // View one file from the app's code. Guarded: the path must stay inside APP_DIR once resolved, and the
    // file must be small and text-ish -- this feeds a <pre>, and a 9 MB sqlite page or a PNG would
    // only stall the WebView.
    if (url.pathname === "/api/files/read" && req.method === "GET") {
      const requested = url.searchParams.get("path") || "";
      const target = resolve(APP_DIR, requested);
      if (target !== APP_DIR && !target.startsWith(APP_DIR + "/")) {
        return Response.json({ error: "Path escapes the app directory" }, { status: 400 });
      }
      const name = target.slice(APP_DIR.length + 1);
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

// Tell the app this bundle is up. The app counts fast failures against a new bundle and rolls back to the previous one
// unless this arrives, so it is sent once the server has stayed up for a few seconds. Outside the app there is no host.
if (bridgeAvailable()) {
  setTimeout(() => {
    bridgeCall("agent.ready").catch(() => {});
  }, 5000);
}
