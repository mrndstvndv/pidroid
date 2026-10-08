/**
 * Machines: other computers a session can run its tools on, over SSH, through a pi-env daemon. The agent itself
 * (model calls, storage, credentials) stays on the phone; a session on a machine has its files and shell there.
 * Each session picks its machine when it is created, and a session without one runs on the phone as before.
 *
 * Key material lives under the machines directory in the app's private storage: one Ed25519 key per machine (the
 * public half is shown so the owner can authorise it on that machine), an ssh config that is empty so the user's
 * own ~/.ssh/config never applies, and a known-hosts file that only ever holds a host key the owner confirmed.
 */

import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import { acceptHostKey, detectPlatform, type RemotePlatform, RemoteExecutionEnv, scanHostKey, sshConnection, type SshTarget } from "@earendil-works/pi-env";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MachineInput {
  name: string;
  host: string;
  /** The login name on the machine. Required: without it ssh would log in as the phone's own user. */
  user: string;
  port?: number | null;
  /** Absolute folder on the machine. Every session on it gets its own directory inside this one. */
  folder: string;
}

export interface MachineRow {
  id: number;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  folder: string;
  /** The public key to add to the machine's authorized_keys. */
  publicKey: string;
  /** The owner confirmed this machine's host key. Nothing connects to a machine until then. */
  trusted: boolean;
  createdAt: number;
}

interface Raw {
  id: number;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  folder: string;
  created_at: number;
  trusted_at: number | null;
}

/** A host name or IP address. A leading dash would be read by ssh as an option, so it is refused. */
const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const NAME_LIMIT = 40;

export class Machines {
  /** Host keys scanned but not yet confirmed, held until the owner accepts the fingerprint shown. */
  private scanned = new Map<number, { lines: string[]; fingerprints: string[] }>();
  private links = new Map<number, ReturnType<typeof sshConnection>>();
  /** Session folders already created on their machine this run, so the directory check runs once. */
  private ready = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly root: string,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    db.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        user TEXT,
        port INTEGER,
        folder TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        trusted_at INTEGER
      );
    `);
  }

  list(): MachineRow[] {
    return (this.db.query("SELECT * FROM machines ORDER BY name COLLATE NOCASE").all() as Raw[]).map(r => this.toRow(r));
  }

  get(id: number): MachineRow | undefined {
    const raw = this.db.query("SELECT * FROM machines WHERE id = ?").get(id) as Raw | null;
    return raw ? this.toRow(raw) : undefined;
  }

  /** Create the machine and its key. Nothing is contacted until the owner confirms the host key. */
  async add(input: MachineInput): Promise<MachineRow> {
    const name = String(input.name ?? "").trim().slice(0, NAME_LIMIT);
    const host = String(input.host ?? "").trim();
    const user = String(input.user ?? "").trim();
    const port = input.port == null || (input.port as unknown) === "" ? null : Number(input.port);
    const folder = String(input.folder ?? "").trim().replace(/\/+$/, "");
    if (!name) throw new Error("Give the machine a name");
    if (!HOST.test(host)) throw new Error("The host must be a host name or an IP address, such as my-mac.local or 192.168.1.20");
    if (!USER.test(user)) throw new Error("Give the user name you log in as on the machine");
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("The port must be between 1 and 65535");
    if (!folder.startsWith("/") || /[\r\n\0]/.test(folder)) throw new Error("The folder must be an absolute path on the machine, such as /Users/you/pidroid");
    if (this.list().some(m => m.name.toLowerCase() === name.toLowerCase())) throw new Error(`A machine named ${name} already exists`);

    const id = Number(
      this.db.query("INSERT INTO machines (name, host, user, port, folder, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(name, host, user, port, folder, Date.now()).lastInsertRowid,
    );
    const dir = this.dirOf(id);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.sshConfigPath(id), "", { mode: 0o600 });
      const key = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `pidroid:${name}`, "-f", this.keyPath(id)], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await key.exited) !== 0) throw new Error(`ssh-keygen failed: ${(await new Response(key.stderr).text()).trim()}`);
    } catch (err) {
      this.db.query("DELETE FROM machines WHERE id = ?").run(id);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return this.get(id)!;
  }

  /** Fetch the host key and return the fingerprints to show. Trust comes only from `trust`. */
  async scan(id: number): Promise<{ fingerprints: string[] }> {
    const machine = this.require(id);
    const { lines, fingerprints } = await scanHostKey(this.target(machine));
    if (fingerprints.length === 0) throw new Error(`${machine.host} did not present a host key`);
    this.scanned.set(id, { lines, fingerprints });
    return { fingerprints };
  }

  /** Accept the host key that was scanned, but only if the owner confirmed exactly that fingerprint. */
  async trust(id: number, fingerprint: string): Promise<void> {
    const machine = this.require(id);
    const pending = this.scanned.get(id);
    if (!pending || !pending.fingerprints.includes(fingerprint)) throw new Error("Scan the host key again and confirm the fingerprint it shows");
    await acceptHostKey(this.target(machine), pending.lines);
    this.db.query("UPDATE machines SET trusted_at = ? WHERE id = ?").run(Date.now(), id);
    this.scanned.delete(id);
    this.links.delete(id);
  }

  /** Connect and report what the machine is. Requires a trusted host key. */
  async probe(id: number): Promise<RemotePlatform> {
    const machine = this.require(id);
    if (!machine.trusted) throw new Error(`Confirm ${machine.name}'s host key first`);
    return detectPlatform(this.target(machine));
  }

  remove(id: number) {
    this.require(id);
    this.db.query("DELETE FROM machines WHERE id = ?").run(id);
    this.links.delete(id);
    this.scanned.delete(id);
    rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  /** The directory a session works in on its machine. Pure: nothing is contacted. */
  sessionFolder(machine: MachineRow, conversationId: number): string {
    return `${machine.folder.replace(/\/+$/, "")}/session-${conversationId}`;
  }

  /**
   * The execution environment for one session on a machine. The session's directory is created on first use,
   * and a failure to reach the machine is the error of the operation that needed it.
   */
  async environment(machine: MachineRow, conversationId: number, context: Context): Promise<RemoteExecutionEnv> {
    if (!machine.trusted) throw new Error(`${machine.name} is not trusted yet: confirm its host key in Machines`);
    const folder = this.sessionFolder(machine, conversationId);
    let link = this.links.get(machine.id);
    if (!link) {
      link = sshConnection(this.target(machine));
      this.links.set(machine.id, link);
    }
    const env = new RemoteExecutionEnv({ connection: link.connection, id: `pi-env:machine-${machine.id}`, cwd: folder });
    const key = `${machine.id}:${folder}`;
    if (!this.ready.has(key)) {
      const made = await env.createDir(folder, { recursive: true }, context);
      if (!made.ok) throw new Error(`Cannot use ${folder} on ${machine.name}: ${String((made.error as Error).message ?? made.error)}`);
      this.ready.add(key);
    }
    return env;
  }

  private require(id: number): MachineRow {
    const machine = this.get(id);
    if (!machine) throw new Error("No such machine");
    return machine;
  }

  private target(machine: MachineRow): SshTarget {
    // A machine saved before the user was required would otherwise log in as the phone's own user.
    if (!machine.user) throw new Error(`${machine.name} has no user name: remove it and add it again with the user you log in as`);
    return {
      host: machine.host,
      user: machine.user,
      port: machine.port ?? undefined,
      identityFile: this.keyPath(machine.id),
      knownHostsFile: join(this.dirOf(machine.id), "known_hosts"),
      hostKeyAlias: `pidroid-machine-${machine.id}`,
      configFile: this.sshConfigPath(machine.id),
    };
  }

  private dirOf(id: number): string {
    return join(this.root, String(id));
  }

  private keyPath(id: number): string {
    return join(this.dirOf(id), "id_ed25519");
  }

  private sshConfigPath(id: number): string {
    return join(this.dirOf(id), "ssh_config");
  }

  private toRow(raw: Raw): MachineRow {
    let publicKey = "";
    try {
      publicKey = readFileSync(`${this.keyPath(raw.id)}.pub`, "utf8").trim();
    } catch {
      // A machine whose key file is missing shows no key; adding it again is the way to recover.
    }
    return {
      id: raw.id,
      name: raw.name,
      host: raw.host,
      user: raw.user,
      port: raw.port,
      folder: raw.folder,
      publicKey,
      trusted: raw.trusted_at !== null,
      createdAt: raw.created_at,
    };
  }
}
