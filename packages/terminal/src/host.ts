/** The terminals one `serve` keeps, and the groups a person put them in. */

import { randomBytes } from "node:crypto";
import type { ObjectStore, SettingsRepository } from "@operad-io/engine";
import type { Clock } from "@operad-io/engine/platform";
import { knownFolder } from "./folders.ts";
import { Session, type Send, type TerminalInfo } from "./session.ts";

/** The type a group is stored as. */
export const GROUP_TYPE = "terminal_group";

const CAUSE = "plugin:terminal";

/** The largest width or height a terminal takes. */
export const MAX_SIZE = 1000;

/** The longest group name. */
export const MAX_GROUP_NAME = 100;

/** The agents offered as command lines when their harness is loaded. */
const PRESET_AGENTS: readonly string[] = ["claude", "codex", "pi"];

/** How often a running terminal's folder is looked at. */
const FOLDER_CHECK_MS = 1_000;

/** A request the host does not carry out, with the HTTP status that says why. */
export class TerminalError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly kind: "args" | "not-found" | "not-available" | "refused" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

export interface GroupInfo {
  readonly id: string;
  readonly name: string;
  /** The ids of the terminals in it. */
  readonly terminals: readonly string[];
}

export interface TerminalList {
  readonly terminals: readonly TerminalInfo[];
  readonly groups: readonly GroupInfo[];
  /** Command lines a client may offer to fill in. */
  readonly presets: readonly { readonly command: string }[];
}

export interface StartInput {
  readonly command: string;
  readonly folder: string;
  readonly cols: number;
  readonly rows: number;
  readonly group: string | undefined;
}

export interface HostOptions {
  readonly home: string;
  readonly store: ObjectStore;
  readonly repositories: () => Promise<readonly SettingsRepository[]>;
  /** The loaded harness plugin names. */
  readonly harnesses: readonly string[];
  readonly shell: string;
  readonly env: Readonly<Record<string, string>>;
  readonly now: () => number;
  readonly clock?: Clock | undefined;
  /** Calls `check` again and again; the function returned ends that. */
  readonly repeat?: ((check: () => void, ms: number) => () => void) | undefined;
  readonly onLog: (message: string) => void;
}

function repeatOnTimer(check: () => void, ms: number): () => void {
  const timer = setInterval(check, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

interface StoredGroup {
  readonly id: string;
  readonly name: string;
}

export class TerminalHost {
  private readonly options: HostOptions;
  private readonly sessions = new Map<string, Session>();
  /** The streams told about changes to the list. */
  private readonly watchers = new Set<Send>();
  private readonly endChecks: () => void;
  private stopping = false;

  constructor(options: HostOptions) {
    this.options = options;
    this.endChecks = (options.repeat ?? repeatOnTimer)(() => this.checkFolders(), FOLDER_CHECK_MS);
  }

  async list(): Promise<TerminalList> {
    const terminals = [...this.sessions.values()].map((session) => session.info());
    const groups = await this.storedGroups();
    return {
      terminals,
      groups: groups.map((group) => this.groupInfo(group)),
      presets: PRESET_AGENTS.filter((name) => this.options.harnesses.includes(name)).map(
        (command) => ({ command }),
      ),
    };
  }

  async start(input: StartInput): Promise<TerminalInfo> {
    const folder = await knownFolder(input.folder, await this.options.repositories());
    if (folder === undefined) {
      throw new TerminalError(
        422,
        "refused",
        `a terminal starts only in a registered repository or one of its worktrees, and "${input.folder}" is neither`,
      );
    }
    if (input.group !== undefined) await this.storedGroup(input.group);
    if (this.stopping) throw new TerminalError(503, "unavailable", "the server is stopping");
    const id = this.newId("t");
    let session: Session;
    try {
      session = new Session({
        id,
        command: input.command.trim() === "" ? "" : input.command,
        folder,
        cols: input.cols,
        rows: input.rows,
        group: input.group ?? null,
        home: this.options.home,
        shell: this.options.shell,
        env: this.options.env,
        now: this.options.now,
        clock: this.options.clock,
        onChange: () => this.changed({ id }),
        onLog: this.options.onLog,
      });
    } catch (error) {
      throw new TerminalError(
        422,
        "refused",
        `the terminal did not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.sessions.set(id, session);
    this.changed({ id });
    return session.info();
  }

  input(id: string, data: string): void {
    this.running(id).write(data);
  }

  resize(id: string, cols: number, rows: number): TerminalInfo {
    const session = this.running(id);
    session.resize(cols, rows);
    return session.info();
  }

  /** Stops the terminal when it runs and takes it off the list; answers how it ended. */
  async close(id: string): Promise<TerminalInfo> {
    const session = this.session(id);
    await session.stop();
    const info = session.info();
    // A second close that waited beside this one finds it gone.
    if (this.sessions.delete(id)) {
      session.dispose();
      this.changed({ id });
    }
    return info;
  }

  async assign(id: string, group: string | null): Promise<TerminalInfo> {
    if (group !== null) await this.storedGroup(group);
    const session = this.session(id);
    session.group = group;
    this.changed({ id });
    return session.info();
  }

  async createGroup(name: string): Promise<GroupInfo> {
    const group: StoredGroup = { id: this.newId("g"), name };
    await this.putGroup(group);
    return this.groupInfo(group);
  }

  async renameGroup(id: string, name: string): Promise<GroupInfo> {
    const group = { ...(await this.storedGroup(id)), name };
    await this.putGroup(group);
    return this.groupInfo(group);
  }

  /** Deletes a group; its terminals keep running, in no group. */
  async deleteGroup(id: string): Promise<void> {
    await this.storedGroup(id);
    await this.options.store.remove(GROUP_TYPE, id);
    for (const session of this.sessions.values()) {
      if (session.group === id) session.group = null;
    }
    this.changed({ group: id });
  }

  /**
   * One event stream: changes to the list, and the screen and output of the
   * terminals it names. A name with no terminal is answered `closed`.
   */
  open(ids: readonly string[], send: Send): () => void {
    this.watchers.add(send);
    const detach: (() => void)[] = [];
    for (const id of new Set(ids)) {
      const session = this.sessions.get(id);
      if (session === undefined) send({ name: "closed", data: { id } });
      else detach.push(session.attach(send));
    }
    return () => {
      this.watchers.delete(send);
      for (const end of detach) end();
    };
  }

  /** Ends every terminal; serve is stopping. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.endChecks();
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => session.stop()));
    for (const session of sessions) session.dispose();
    this.sessions.clear();
    this.watchers.clear();
  }

  private checkFolders(): void {
    for (const session of this.sessions.values()) {
      session.checkFolder().catch((error: unknown) => {
        this.options.onLog(`terminal ${session.id}: ${String(error)}`);
      });
    }
  }

  private changed(what: { readonly id: string } | { readonly group: string }): void {
    for (const send of [...this.watchers]) send({ name: "change", data: what });
  }

  /** Random, so an id from before a restart never names a new terminal. */
  private newId(prefix: "t" | "g"): string {
    return `${prefix}-${randomBytes(6).toString("hex")}`;
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (session === undefined) throw new TerminalError(404, "not-found", `no terminal "${id}"`);
    return session;
  }

  private running(id: string): Session {
    const session = this.session(id);
    if (!session.running) {
      throw new TerminalError(409, "not-available", `terminal "${id}" has ended`);
    }
    return session;
  }

  private async putGroup(group: StoredGroup): Promise<void> {
    await this.options.store.put(GROUP_TYPE, group.id, { name: group.name }, CAUSE);
    this.changed({ group: group.id });
  }

  private async storedGroup(id: string): Promise<StoredGroup> {
    const found = id === "" ? undefined : await this.options.store.get(GROUP_TYPE, id);
    if (found === undefined) throw new TerminalError(404, "not-found", `"group": nothing has the id "${id}"`);
    return groupOf(found.id, found.data);
  }

  private async storedGroups(): Promise<readonly StoredGroup[]> {
    const groups: StoredGroup[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.store.list(
        GROUP_TYPE,
        cursor === undefined ? {} : { cursor },
      );
      groups.push(...page.objects.map((object) => groupOf(object.id, object.data)));
      cursor = page.next;
    } while (cursor !== undefined);
    return groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private groupInfo(group: StoredGroup): GroupInfo {
    return {
      id: group.id,
      name: group.name,
      terminals: [...this.sessions.values()]
        .filter((session) => session.group === group.id)
        .map((session) => session.id),
    };
  }
}

function groupOf(id: string, data: Readonly<Record<string, unknown>>): StoredGroup {
  return { id, name: typeof data.name === "string" ? data.name : "" };
}
