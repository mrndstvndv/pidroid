/**
 * Agent Skills catalog for Pidroid.
 *
 * Shared user skills live outside the app source and per-session workspaces, at
 * <app-data>/skills/<skill-name>/SKILL.md. The prompt advertises names/descriptions/paths; the
 * model can read relevant instructions, and `/skill:name` explicitly embeds the full skill body.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
const APP_DIR = decodeURIComponent(new URL("./", import.meta.url).pathname).replace(/\/$/, "");
export const SKILLS_DIR = join(dirname(APP_DIR), "skills");
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_DIRECTORIES = 2000;

// server.ts imports this module, so a failed mkdir here must not stop the server from starting.
// discoverSkills already returns an empty list when the folder is missing.
try {
  mkdirSync(SKILLS_DIR, { recursive: true });
} catch (error) {
  console.warn(`[pidroid] could not create skills folder ${SKILLS_DIR}: ${error instanceof Error ? error.message : String(error)}`);
}

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
}

export interface SkillExpansionResult {
  /** Text sent to pi-durable; a known command contains Pi's explicit skill block. */
  content: string;
  skill?: SkillMetadata;
  error?: string;
}

/**
 * Parsed results keyed by SKILL.md path. The prompt re-scans skills on every model request, and
 * reading and parsing every file each time is wasted work when almost nothing has changed. A file
 * is re-parsed only when its mtime or size moves; the directory scan still runs every time, so new
 * skills are picked up without a restart. Invalid files are cached too (as undefined).
 */
const metadataCache = new Map<string, { mtimeMs: number; size: number; result: SkillMetadata | undefined }>();

const reported = new Set<string>();

function warnOnce(path: string, reason: string): void {
  const key = `${path}\n${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[pidroid] skill ${path}: ${reason}`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function metadataFrom(filePath: string, folderName: string): SkillMetadata | undefined {
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    warnOnce(filePath, `could not read SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const cached = metadataCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.result;

  const result = parseSkillFile(filePath, folderName, stats.size);
  metadataCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, result });
  return result;
}

function parseSkillFile(filePath: string, folderName: string, size: number): SkillMetadata | undefined {
  let raw: string;
  try {
    if (size > MAX_SKILL_FILE_BYTES) {
      warnOnce(filePath, `SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes; skipping`);
      return undefined;
    }
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    warnOnce(filePath, `could not read SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!frontmatter) {
    warnOnce(filePath, "missing YAML frontmatter; expected --- at the start of SKILL.md");
    return undefined;
  }

  let parsed: unknown;
  try {
    const yaml = (globalThis as any).Bun?.YAML;
    if (typeof yaml?.parse !== "function") throw new Error("Bun YAML parser is unavailable");
    parsed = yaml.parse(frontmatter[1]);
  } catch (error) {
    warnOnce(filePath, `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnOnce(filePath, "YAML frontmatter must be a mapping");
    return undefined;
  }

  const metadata = parsed as Record<string, unknown>;
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  if (!name) {
    warnOnce(filePath, "missing required 'name' field; skipping skill");
    return undefined;
  }
  if (!description) {
    warnOnce(filePath, "missing required 'description' field; skipping skill");
    return undefined;
  }

  if (name.length > MAX_NAME_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    warnOnce(filePath, `name '${name}' does not follow the Agent Skills naming rules`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    warnOnce(filePath, `description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (name !== folderName) {
    // The spec requires a directory/name match. Follow Pi's lenient behavior: keep a usable
    // skill visible, but make the portability issue clear in the server log.
    warnOnce(filePath, `name '${name}' does not match its directory '${folderName}'`);
  }

  return { name, description, location: filePath };
}

/** Discover Agent Skills folders recursively, stopping at each directory that owns SKILL.md. */
export function discoverSkills(root = SKILLS_DIR): SkillMetadata[] {
  if (!existsSync(root)) return [];
  const skills: SkillMetadata[] = [];
  const names = new Set<string>();
  let scannedDirectories = 0;

  const scan = (directory: string, depth: number): void => {
    if (++scannedDirectories > MAX_SCAN_DIRECTORIES) {
      warnOnce(root, `stopped after scanning ${MAX_SCAN_DIRECTORIES} directories`);
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      warnOnce(directory, `could not scan directory: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // A SKILL.md at the root would otherwise claim the whole tree and hide every real skill, so
    // the root is never a skill. Its children are still scanned below.
    const skillEntry = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
    if (skillEntry && depth === 0) {
      warnOnce(join(directory, skillEntry.name), "SKILL.md directly in the skills folder is ignored; put each skill in its own folder");
    } else if (skillEntry) {
      const skillFile = join(directory, skillEntry.name);
      const skill = metadataFrom(skillFile, directory.split(/[\\/]/).pop() ?? directory);
      if (skill) {
        if (names.has(skill.name)) {
          warnOnce(skillFile, `duplicate skill name '${skill.name}'; keeping the first discovered skill`);
        } else {
          names.add(skill.name);
          skills.push(skill);
        }
      }
      return; // Resources below a skill directory are not separate skills.
    }

    if (depth >= MAX_SCAN_DEPTH) {
      if (entries.some((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
        warnOnce(directory, `stopped descending at depth ${MAX_SCAN_DEPTH}`);
      }
      return;
    }
    for (const entry of entries) {
      // Do not follow symlinks, hidden directories, or dependency trees outside the skill root.
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      scan(join(directory, entry.name), depth + 1);
      if (scannedDirectories > MAX_SCAN_DIRECTORIES) return;
    }
  };

  scan(root, 0);
  return skills;
}

/**
 * Expand Pi's explicit `/skill:name [request]` form into the user-message block used by
 * pi-coding-agent. The complete SKILL.md body is injected only for an explicit invocation;
 * ordinary prompts still get the small name/description catalog from renderSkillsPrompt().
 */
export function expandSkillCommand(message: string, root = SKILLS_DIR): SkillExpansionResult {
  if (!message.startsWith("/skill:")) return { content: message };
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match) return { content: message, error: "Use /skill:<name> followed by any request for the skill." };

  const [, name, rawArgs = ""] = match;
  const skill = discoverSkills(root).find((candidate) => candidate.name === name);
  if (!skill) return { content: message, error: `Skill '${name}' was not found. Type /skill: to browse available skills.` };

  try {
    // A skill can change between discovery and invocation. Refuse symlinks and paths that escaped
    // the shared skills root rather than reading a replacement file outside the catalog.
    const rootPath = realpathSync(root);
    const filePath = realpathSync(skill.location);
    const fileStat = lstatSync(skill.location);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("SKILL.md is no longer a regular file");
    const rootPrefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
    if (!filePath.startsWith(rootPrefix)) throw new Error("SKILL.md is outside the shared skills directory");
    if (fileStat.size > MAX_SKILL_FILE_BYTES) throw new Error(`SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes`);

    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const body = raw
      .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
      .trim();
    const baseDir = dirname(filePath);
    const block =
      `<skill name="${escapeXml(name)}" location="${escapeXml(filePath)}">\n` +
      `References are relative to ${escapeXml(baseDir)}.\n\n${body}\n</skill>`;
    const args = rawArgs.trim();
    return { content: args ? `${block}\n\n${args}` : block, skill };
  } catch (error) {
    return {
      content: message,
      skill,
      error: `Could not load skill '${name}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function renderSkillsPrompt(): string | undefined {
  const skills = discoverSkills();
  if (!skills.length) return undefined;

  const lines = [
    "These skills provide specialized instructions for particular tasks.",
    "When a skill's description matches the task, use the read tool to load its SKILL.md before proceeding.",
    "Resolve paths referenced by a skill relative to the directory containing its SKILL.md; use absolute paths with the file tools.",
    "Load only relevant skills and supporting files, not the whole skills directory.",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

