/**
 * Where things live on the device. The Android host starts this server with three roots in its
 * environment; every path the agent reads or writes is derived from them, never from the working
 * directory (which is only the app directory by convention).
 *
 *  - APP_DIR  (PIDROID_APP_DIR)  the active bundle: code and the web UI. Read-only. The app replaces
 *                                it wholesale when an update is installed.
 *  - DATA_DIR (PIDROID_DATA_DIR) the app's private state: databases, credentials, machine keys,
 *                                uploads, exports, and user extensions in DATA_DIR/extensions.
 *  - HOME_DIR (PIDROID_HOME)     the app's files directory: session workspaces and shared skills.
 *
 * Outside the app the fallbacks are the layout the app uses: APP_DIR is the directory this file
 * sits in, DATA_DIR and HOME_DIR are its parents' `data` and `..`.
 */

import { join, resolve } from "node:path";

/** The bundle: server code, the web UI and the built-in extensions. Never written to by the agent. */
export const APP_DIR = resolve(process.env.PIDROID_APP_DIR || import.meta.dir);

/** The app's private state. Everything the server writes lives here, not in the bundle. */
export const DATA_DIR = resolve(process.env.PIDROID_DATA_DIR || join(APP_DIR, "..", "data"));

/** The app's files directory: the parent of the session workspaces and the shared skills. */
export const HOME_DIR = resolve(process.env.PIDROID_HOME || join(APP_DIR, ".."));

/** One directory per conversation: the agent's scratch space for that session. */
export const WORKSPACES_DIR = join(HOME_DIR, "workspaces");

/** Shared Agent Skills, one directory per skill. Outside the bundle, so they survive app updates. */
export const SKILLS_DIR = join(HOME_DIR, "skills");

/** Extensions shipped with the app (read-only examples and the built-in tools). */
export const BUILTIN_EXTENSIONS_DIR = join(APP_DIR, "extensions");

/** Extensions the agent writes for the user. Loaded after the built-in ones, so they can add to or replace them. */
export const USER_EXTENSIONS_DIR = join(DATA_DIR, "extensions");
