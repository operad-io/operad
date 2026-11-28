/**
 * One terminal: a command on a pseudo terminal in a folder, with a headless
 * terminal fed the same output, so a client that connects can be given the
 * screen and then the output that follows it.
 */

import { closeSync, openSync, statSync } from "node:fs";
import type { PluginStreamEvent } from "@operad-io/engine";
import { holdFolder, spawnPty, type Clock, type FolderHold, type Pty } from "@operad-io/engine/platform";
import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { splitUnfinished } from "./escape.ts";
import { OutputQueue } from "./queue.ts";
import { replayOf } from "./replay.ts";

/** How many lines above the screen a terminal keeps. */
export const SCROLLBACK_LINES = 5000;

/** Why a terminal whose folder went away ended. */
export const FOLDER_REMOVED_REASON = "stopped because its folder was removed";

/** What a terminal tells its readers. */
export type Send = (event: PluginStreamEvent) => void;

/** A terminal as the list shows it. */
export interface TerminalInfo {
  readonly id: string;
  /** The command line; empty for the login shell itself. */
  readonly command: string;
  readonly folder: string;
  /** The registered repository whose folder or worktree `folder` was at the start. */
  readonly repository: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly group: string | null;
  readonly state: "running" | "ended";
  /** The exit code of an ended terminal; 128 plus the number for a signal. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Why it ended, when neither its command nor a person ended it. */
  readonly reason: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface SessionOptions {
  readonly id: string;
  readonly command: string;
  readonly folder: string;
  readonly repository: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly group: string | null;
  readonly home: string;
  /** The person's login shell. */
  readonly shell: string;
  readonly env: Readonly<Record<string, string>>;
  readonly now: () => number;
  readonly clock?: Clock | undefined;
  /** Called when something the list shows changed. */
  readonly onChange: () => void;
  readonly onLog: (message: string) => void;
}

/**
 * Keeps a folder open, so that while it is open no folder made in its place can
 * get its inode number, even after it is removed.
 */
function keepOpen(folder: string): number | undefined {
  try {
    return openSync(folder, "r");
  } catch {
    return undefined;
  }
}

/** The identity of a folder: a removed folder, even one made again, differs. */
function folderIdentity(folder: string): string | undefined {
  try {
    const found = statSync(folder);
    return found.isDirectory() ? `${found.dev}:${found.ino}` : undefined;
  } catch {
    return undefined;
  }
}

export class Session {
  readonly id: string;
  /** Settles once the terminal ended and its last output was passed on. */
  readonly ended: Promise<void>;
  group: string | null;
  private readonly options: SessionOptions;
  private readonly pty: Pty;
  private readonly hold: FolderHold;
  private readonly folderAtStart: string | undefined;
  private folderHandle: number | undefined;
  private readonly screen: InstanceType<typeof headless.Terminal>;
  private readonly serializer = new SerializeAddon();
  private readonly decoder = new TextDecoder();
  /** Everything that goes through the headless terminal, in order. */
  private readonly queue: OutputQueue;
  /** The readers that already have the screen; the first one answers the program. */
  private readonly readers = new Set<Send>();
  /** The readers whose screen is still to be sent. */
  private readonly joining = new Set<Send>();
  private held = "";
  private cols: number;
  private rows: number;
  private end: { exitCode: number | null; signal: string | null; reason: string | null; at: number } | undefined;
  private stopReason: string | null = null;
  /** Whether the command ended and processes it started may still run. */
  private leftRunning = false;
  private readonly startedAt: number;
  private disposed = false;

  /** Starts the command; throws when the shell cannot be started. */
  constructor(options: SessionOptions) {
    this.options = options;
    this.id = options.id;
    this.group = options.group;
    this.cols = options.cols;
    this.rows = options.rows;
    this.startedAt = options.now();
    this.folderAtStart = folderIdentity(options.folder);
    this.screen = new headless.Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    // The addon is typed against the browser terminal, which shares the interface it uses.
    this.screen.loadAddon(this.serializer as unknown as Parameters<typeof this.screen.loadAddon>[0]);
    this.queue = new OutputQueue(this.screen, {
      onDrop: () =>
        options.onLog(`terminal ${options.id}: output came faster than it could be read; some was left out`),
    });
    this.pty = spawnPty({
      argv:
        options.command === ""
          ? [options.shell, "-il"]
          : [options.shell, "-ilc", options.command],
      cwd: options.folder,
      cols: options.cols,
      rows: options.rows,
      env: { ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      onData: (bytes) => this.receive(this.decoder.decode(bytes, { stream: true })),
    });
    try {
      this.hold = holdFolder({
        home: options.home,
        folder: options.folder,
        pid: this.pty.pid,
        marker: this.pty.marker,
      });
    } catch (error) {
      // A process nothing could stop before its folder goes is not kept.
      void this.pty.hangUp();
      throw error;
    }
    // A program asks its terminal things, such as where the cursor is. One
    // reader answers them; with none, the headless terminal does.
    this.screen.onData((reply) => {
      if (this.readers.size === 0) this.pty.write(reply);
    });
    this.folderHandle = keepOpen(options.folder);
    this.ended = this.pty.exited.then((exit) => this.finish(exit.code, exit.signal));
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      command: this.options.command,
      folder: this.options.folder,
      repository: this.options.repository,
      cols: this.cols,
      rows: this.rows,
      group: this.group,
      state: this.end === undefined ? "running" : "ended",
      exitCode: this.end?.exitCode ?? null,
      signal: this.end?.signal ?? null,
      reason: this.end?.reason ?? null,
      startedAt: this.startedAt,
      endedAt: this.end?.at ?? null,
    };
  }

  get running(): boolean {
    return this.end === undefined;
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
    // In turn with the output, so readers see the change where it happened.
    this.afterOutput(() => {
      this.screen.resize(cols, rows);
      this.tell({ name: "resize", data: { id: this.id, cols, rows } });
    });
    this.options.onChange();
  }

  /** Sends the screen, then everything that follows it, until the function returned is called. */
  attach(send: Send): () => void {
    this.joining.add(send);
    this.afterOutput(() => {
      if (!this.joining.delete(send)) return;
      send({
        name: "screen",
        data: {
          ...this.info(),
          data: replayOf(this.screen, this.serializer),
          answers: this.readers.size === 0,
        },
        snapshot: true,
      });
      this.readers.add(send);
    });
    return () => this.detach(send);
  }

  /**
   * Stops the command and everything it started, also what still runs after the
   * command ended; `reason` is shown with a terminal this ends.
   */
  async stop(reason: string | null = null): Promise<void> {
    if (this.end !== undefined && !this.leftRunning) return;
    if (this.end === undefined) this.stopReason ??= reason;
    await this.pty.hangUp();
    await this.ended;
    this.leftRunning = false;
    this.hold.drop();
  }

  /** Stops the terminal when its folder is not the one it started in any more. */
  async checkFolder(): Promise<void> {
    if (this.end !== undefined && !this.leftRunning) return;
    if (folderIdentity(this.options.folder) === this.folderAtStart) return;
    await this.stop(FOLDER_REMOVED_REASON);
  }

  /** Tells the readers the terminal left the list, and frees the screen. */
  dispose(): void {
    for (const send of this.joining) this.readers.add(send);
    this.joining.clear();
    this.tell({ name: "closed", data: { id: this.id } });
    this.disposed = true;
    this.readers.clear();
    this.screen.dispose();
  }

  private detach(send: Send): void {
    this.joining.delete(send);
    const answered = this.answerer() === send;
    if (!this.readers.delete(send) || !answered) return;
    this.answerer()?.({ name: "answers", data: { id: this.id } });
  }

  private answerer(): Send | undefined {
    return this.readers.values().next().value;
  }

  /** Runs `work` once the headless terminal has parsed all output given so far. */
  private afterOutput(work: () => void): void {
    if (this.disposed) return;
    this.queue.run(() => {
      if (!this.disposed) work();
    });
  }

  private receive(text: string): void {
    const [whole, held] = splitUnfinished(this.held + text);
    this.held = held;
    this.feed(whole);
  }

  private feed(text: string): void {
    if (text === "" || this.disposed) return;
    this.queue.write(text, () => this.tell({ name: "output", data: { id: this.id, data: text } }));
  }

  private tell(event: PluginStreamEvent): void {
    for (const send of [...this.readers]) send(event);
  }

  private async finish(code: number | null, signal: string | null): Promise<void> {
    // What the command left running keeps the folder held. When that cannot be
    // told, it is taken to be so.
    this.leftRunning = await this.pty.alive().catch(() => true);
    const released = this.hold.released();
    if (!this.leftRunning) this.hold.drop();
    if (this.folderHandle !== undefined) closeSync(this.folderHandle);
    this.folderHandle = undefined;
    this.feed(this.held + this.decoder.decode());
    this.held = "";
    return new Promise((resolve) => {
      this.afterOutput(() => {
        this.end = {
          exitCode: code,
          signal,
          reason: released ? FOLDER_REMOVED_REASON : this.stopReason,
          at: this.options.now(),
        };
        this.tell({
          name: "exit",
          data: { id: this.id, exitCode: code, signal, reason: this.end.reason },
        });
        this.options.onChange();
        resolve();
      });
    });
  }
}
