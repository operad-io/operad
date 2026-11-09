/**
 * The Claude Code channel: one-way change notifications beside the read tools.
 *
 * Two subscriptions are the source: the store's object changes, and the run
 * log's changes. The waiting and running flags come from the runs, so a wait
 * that opens or a step that starts touches no object. Each change re-reads the
 * object's row. A watch is the fast path and each backend's own timer is the
 * fallback, so a change another process writes is seen too. The server
 * remembers the row it last saw for each object and sends only when its state
 * differs or its waiting flag turns on, and never repeats the row it last sent.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHANNEL_NOTIFY_KINDS,
  DEFAULT_MCP_CHANNEL,
  messageOf,
  type ChannelNotifyKind,
  ViewError,
  type LogBackend,
  type ObjectRef,
  type PendingItem,
  type PluginRegistry,
  type ViewObject,
  type ViewRow,
  type Views,
} from "@operad-io/engine";

/** The experiment capability Claude Code reads a channel declaration from. */
export const CHANNEL_CAPABILITY = "claude/channel";

/** The capability this server never declares: it relays no permission prompts. */
export const CHANNEL_PERMISSION_CAPABILITY = "claude/channel/permission";

/** The notification method a channel event is sent with. */
export const CHANNEL_METHOD = "notifications/claude/channel";

/** The paragraph the channel adds to the server's instructions. */
export const CHANNEL_INSTRUCTIONS =
  "Events arrive as `<channel>` blocks with the meta attributes `id`, `type`, `state`, `previous`, `waiting`, `running` and `reason`, and `step` while the object has an active run. `reason` says why the block was sent: `waiting` (something now waits for a person; the content carries the reason when the object has one), `ended` (the object reached a final state) or `loop` (the object reached the same state several times in a row with no wait or end between, so it is going round in circles). Other state changes send nothing unless `mcp.channel.notify` in the operad config.json lists `changes`, which sends every state change with reason `changes`. They are one-way: there is no reply tool. Read the details with `show`, `section`, `pending` and `history`.";

/** One notification's parameters: a one-line content and string meta. */
export interface ChannelNotification {
  readonly content: string;
  readonly meta: {
    readonly id: string;
    readonly type: string;
    readonly state: string;
    readonly previous: string;
    readonly waiting: string;
    readonly running: string;
    /** Why the block was sent. */
    readonly reason: ChannelReason;
    /** The active run's last step; absent when the object has no active run. */
    readonly step?: string;
  };
}

/** Why a block was sent; `changes` is only used when `notify` lists it. */
export type ChannelReason = "waiting" | "ended" | "loop" | "changes";

/** A `notify` entry that is not a kind of block. */
export class ChannelNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelNotifyError";
  }
}

/** A `--types` entry that is not an object type with views. */
export class ChannelTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelTypeError";
  }
}

/** What a channel needs: the views, both subscriptions and one writer. */
export interface ChannelOptions {
  readonly views: Views;
  readonly registry: PluginRegistry;
  /** The run log; its changes carry the waiting and running flags. */
  readonly log?: LogBackend | undefined;
  /**
   * Hold every notification until `release` is called. The channel still reads
   * its starting rows and keeps diffing, so the release sends the changes seen
   * since the start.
   */
  readonly hold?: boolean | undefined;
  /** The object types to report; the default is every type with views. */
  readonly types?: readonly string[] | undefined;
  /** What to send a block for; the default is waits, ends and loops. */
  readonly notify?: readonly ChannelNotifyKind[] | undefined;
  /** How many arrivals at one state make a loop; the default is 3. */
  readonly loopAfter?: number | undefined;
  /** Reads the pending items, whose prompt is the reason of a wait. */
  readonly pending?: (() => Promise<readonly PendingItem[]>) | undefined;
  /**
   * A JSON file that keeps the row each object's last delivered block reported,
   * so a restarted server does not send a block again. Without it the memory
   * lasts as long as the channel.
   */
  readonly sentFile?: string | undefined;
  readonly send: (
    notification: ChannelNotification,
  ) => void | Promise<void>;
  readonly onLog?: ((message: string) => void) | undefined;
}

/** A running channel. Closing it stops the subscription and waits for sends. */
export interface ChannelHandle {
  /** Sends the notifications held since the start, then stops holding. */
  release(): Promise<void>;
  close(): Promise<void>;
}

interface SeenRow {
  readonly state: string;
  readonly waiting: boolean;
  readonly running: boolean;
  /** The plugin marked the state final; not part of what was sent. */
  readonly final: boolean;
  /** A loop block was delivered for the stretch this row belongs to. */
  readonly looped?: boolean;
}

/** Reads a run's object key, such as `task:42`. */
function objectOf(key: string | undefined): ObjectRef | undefined {
  if (key === undefined) return undefined;
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return undefined;
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

function rowKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

function seenRow(row: ViewRow): SeenRow {
  return {
    state: row.state,
    waiting: row.waiting,
    running: row.running,
    final: row.final === true,
  };
}

function sameRow(left: SeenRow, right: SeenRow): boolean {
  return (
    left.state === right.state &&
    left.waiting === right.waiting &&
    left.running === right.running
  );
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function contentOf(
  row: ViewRow,
  previous: string,
  fallback: string | undefined,
): string {
  const text =
    typeof row.note === "string" && row.note.trim().length > 0
      ? row.note
      : fallback;
  const note =
    text !== undefined && text.trim().length > 0 ? `: ${oneLine(text)}` : "";
  return `${oneLine(row.id)} ${previous} -> ${oneLine(row.state)}${note}`;
}

function notificationOf(
  type: string,
  row: ViewRow,
  previous: string,
  step: string | undefined,
  reason: ChannelReason,
  fallback?: string,
): ChannelNotification {
  return {
    content: contentOf(row, previous, fallback),
    meta: {
      id: oneLine(row.id),
      type,
      state: oneLine(row.state),
      previous: oneLine(previous),
      waiting: row.waiting ? "true" : "false",
      running: row.running ? "true" : "false",
      reason,
      ...(step === undefined ? {} : { step: oneLine(step) }),
    },
  };
}

/** A notification with the key and row its delivery records as sent. */
interface Held {
  readonly notification: ChannelNotification;
  readonly key: string;
  readonly row: SeenRow;
}

function isSeenRow(value: unknown): value is SeenRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.state === "string" &&
    typeof row.waiting === "boolean" &&
    typeof row.running === "boolean"
  );
}

class ClaudeChannel implements ChannelHandle {
  private readonly views: Views;
  private readonly registry: PluginRegistry;
  private readonly types: ReadonlySet<string>;
  private readonly sendNotification: (
    notification: ChannelNotification,
  ) => void | Promise<void>;
  private readonly onLog: (message: string) => void;
  private readonly last = new Map<string, SeenRow>();
  /** The row each object's last block reported. */
  private readonly sent = new Map<string, SeenRow>();
  /** Rows of blocks held for release, which count as sent for comparing. */
  private readonly pendingSent = new Map<string, SeenRow>();
  private readonly notify: ReadonlySet<ChannelNotifyKind>;
  private readonly loopAfter: number;
  private readonly pendingItems:
    | (() => Promise<readonly PendingItem[]>)
    | undefined;
  /**
   * Per object: how often each state was reached since the last wait or end,
   * and whether a loop block was already sent for that stretch.
   */
  private readonly visits = new Map<
    string,
    { counts: Map<string, number>; looped: boolean }
  >();
  /** Objects whose current wait was skipped because its plugin answers it. */
  private readonly quiet = new Map<string, ObjectRef>();
  private readonly sentFile: string | undefined;
  private readonly log: LogBackend | undefined;
  /** Types whose starting rows could not be read: a first sighting is a baseline. */
  private readonly unseeded = new Set<string>();
  private held: Held[] | undefined;
  private stops: (() => void)[] = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: ChannelOptions) {
    this.views = options.views;
    this.registry = options.registry;
    if (options.types !== undefined) {
      for (const type of options.types) {
        if (this.registry.viewsFor(type) === undefined) {
          throw new ChannelTypeError(
            `mcp --types: "${type}" is not an object type with views`,
          );
        }
      }
    }
    this.types =
      options.types === undefined
        ? new Set(
            this.registry
              .objectTypes()
              .map((entry) => entry.type)
              .filter((type) => this.registry.viewsFor(type) !== undefined),
          )
        : new Set(options.types);
    for (const kind of options.notify ?? []) {
      if (!CHANNEL_NOTIFY_KINDS.includes(kind)) {
        throw new ChannelNotifyError(
          `mcp channel notify: unknown entry "${String(kind)}"`,
        );
      }
    }
    this.notify = new Set(options.notify ?? DEFAULT_MCP_CHANNEL.notify);
    this.loopAfter = options.loopAfter ?? DEFAULT_MCP_CHANNEL.loopAfter;
    this.pendingItems = options.pending;
    this.log = options.log;
    this.sentFile = options.sentFile;
    this.held = options.hold === true ? [] : undefined;
    this.sendNotification = options.send;
    this.onLog = options.onLog ?? ((message) => console.error(message));
  }

  async start(): Promise<void> {
    await this.loadSent();
    for (const type of this.types) {
      try {
        await this.seed(type);
      } catch (error) {
        this.unseeded.add(type);
        this.onLog(
          `channel: the starting rows of "${type}" could not be read: ${messageOf(error)}`,
        );
      }
    }
    if (this.closed) return;
    this.stops.push(
      this.registry.store.subscribe((object) => {
        this.enqueue(object);
      }),
    );
    if (this.log?.subscribe === undefined) {
      this.onLog(
        "channel: the run log cannot notify, so a wait or a running step is not reported until the object changes",
      );
    } else {
      this.stops.push(
        this.log.subscribe((change) => {
          const object = objectOf(change.object);
          if (object !== undefined) this.enqueue(object);
        }),
      );
    }
  }

  async release(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const held = this.held;
      this.held = undefined;
      for (const entry of held ?? []) {
        if (this.closed) return;
        await this.deliver(entry);
      }
    });
    await this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.stops) stop();
    this.stops = [];
    await this.queue;
  }

  /** Sends one block, then records its row as the last one delivered. */
  private async deliver(entry: Held): Promise<void> {
    await this.sendNotification(entry.notification);
    const looped = this.visits.get(entry.key)?.looped === true;
    this.sent.set(entry.key, looped ? { ...entry.row, looped } : entry.row);
    if (this.pendingSent.get(entry.key) === entry.row) {
      this.pendingSent.delete(entry.key);
    }
    await this.saveSent();
  }

  private async loadSent(): Promise<void> {
    if (this.sentFile === undefined) return;
    let text: string;
    try {
      text = await readFile(this.sentFile, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return;
      this.onLog(`channel: the sent rows could not be read: ${messageOf(error)}`);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return;
      for (const [key, value] of Object.entries(parsed)) {
        if (isSeenRow(value)) {
          this.sent.set(key, {
            state: value.state,
            waiting: value.waiting,
            running: value.running,
            final: false,
          });
          if ((value as { looped?: unknown }).looped === true) {
            this.visits.set(key, { counts: new Map(), looped: true });
          }
        }
      }
    } catch (error) {
      this.onLog(`channel: the sent rows could not be read: ${messageOf(error)}`);
    }
  }

  private async saveSent(): Promise<void> {
    if (this.sentFile === undefined) return;
    try {
      await mkdir(dirname(this.sentFile), { recursive: true });
      const temp = `${this.sentFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.sent)));
      await rename(temp, this.sentFile);
    } catch (error) {
      this.onLog(`channel: the sent rows could not be saved: ${messageOf(error)}`);
    }
  }

  /** Reads the rows that exist now; none of them is a change to report. */
  private async seed(type: string): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.views.list(
        type,
        cursor === undefined ? {} : { cursor },
      );
      for (const row of page.rows) {
        this.last.set(rowKey(type, row.id), seenRow(row));
      }
      if (page.next === undefined) return;
      cursor = page.next;
    }
  }

  /**
   * Counts the arrival at the row's state. A wait or an end starts a new
   * stretch. Returns true once per stretch, when a state is reached
   * `loopAfter` times.
   */
  private countVisit(
    key: string,
    row: SeenRow,
    stateChanged: boolean,
    reset: boolean,
  ): boolean {
    if (reset) {
      const fresh = {
        counts: new Map<string, number>(),
        looped: false,
      };
      if (!row.final && stateChanged) fresh.counts.set(row.state, 1);
      this.visits.set(key, fresh);
      return false;
    }
    let entry = this.visits.get(key);
    if (entry === undefined) {
      entry = { counts: new Map(), looped: false };
      this.visits.set(key, entry);
    }
    if (!stateChanged) return false;
    const count = (entry.counts.get(row.state) ?? 0) + 1;
    entry.counts.set(row.state, count);
    if (count >= this.loopAfter && !entry.looped) {
      entry.looped = true;
      return true;
    }
    return false;
  }

  private enqueue(object: ObjectRef): void {
    if (this.closed) return;
    this.queue = this.queue
      .then(() => this.handle(object))
      .catch((error) => {
        this.onLog(`channel: ${messageOf(error)}`);
      });
  }

  /** The last step of the object's active run, if it has one. */
  private async stepOf(object: ObjectRef): Promise<string | undefined> {
    if (this.log === undefined) return undefined;
    try {
      const key = `${object.type}:${object.id}`;
      const runs = await this.log.runs({ active: true });
      // An object can have active runs of several flows: report the run with
      // the latest fact, which is the one that changed the object just now.
      let step: string | undefined;
      let latest:
        | { time: number; started: number; seq: number; runId: string }
        | undefined;
      for (const run of runs) {
        if (run.object !== key) continue;
        let runStep: string | undefined;
        let time = run.startedAt;
        let seq = 0;
        for await (const fact of this.log.read(run.runId)) {
          time = Math.max(time, fact.time);
          seq = Math.max(seq, fact.seq);
          const payload = fact.payload;
          if (
            fact.kind === "step_entered" &&
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload) &&
            payload.kind !== "end" &&
            typeof payload.step === "string"
          ) {
            runStep = payload.step;
          }
        }
        if (
          latest === undefined ||
          laterRun(
            { time, started: run.startedAt, seq, runId: run.runId },
            latest,
          )
        ) {
          latest = { time, started: run.startedAt, seq, runId: run.runId };
          step = runStep;
        }
      }
      return step;
    } catch (error) {
      this.onLog(`channel: the step of "${object.type}:${object.id}" could not be read: ${messageOf(error)}`);
      return undefined;
    }
  }

  /** The pending item of the object's wait, if it has one. */
  private async waitItem(object: ObjectRef): Promise<PendingItem | undefined> {
    if (this.pendingItems === undefined) return undefined;
    try {
      const key = `${object.type}:${object.id}`;
      return (await this.pendingItems()).find((entry) => entry.object === key);
    } catch (error) {
      this.onLog(`channel: the pending items could not be read: ${messageOf(error)}`);
      return undefined;
    }
  }

  private async handle(object: ObjectRef, recheck = true): Promise<void> {
    if (this.closed) return;
    if (recheck && this.quiet.size > 0) {
      // A change elsewhere (a plan's auto level) can end an automatic answer.
      for (const [quietKey, ref] of [...this.quiet]) {
        if (quietKey !== rowKey(object.type, object.id)) {
          await this.handle(ref, false);
        }
      }
    }
    if (!this.types.has(object.type)) return;
    let current: ViewObject;
    try {
      current = await this.views.get(`${object.type}:${object.id}`);
    } catch (error) {
      if (error instanceof ViewError && error.kind === "not-found") {
        // A deleted object: forget it, so a new one with the same id is new.
        this.last.delete(rowKey(object.type, object.id));
        this.pendingSent.delete(rowKey(object.type, object.id));
        this.visits.delete(rowKey(object.type, object.id));
        this.quiet.delete(rowKey(object.type, object.id));
        if (this.sent.delete(rowKey(object.type, object.id))) {
          await this.saveSent();
        }
        return;
      }
      this.onLog(
        `channel: "${object.type}:${object.id}" could not be read: ${messageOf(error)}`,
      );
      return;
    }
    const row = current.row;
    const key = rowKey(object.type, row.id);
    const next = seenRow(row);
    const previous = this.last.get(key);
    this.last.set(key, next);
    if (previous === undefined && this.unseeded.has(object.type)) return;
    const stateChanged = previous === undefined || previous.state !== next.state;
    const waitStart = next.waiting && previous?.waiting !== true;
    // A wait the plugin answers itself is not announced; if the answer does
    // not come, the next change finds the wait no longer marked and announces.
    let item: PendingItem | undefined;
    let waitingOn = waitStart;
    if (next.waiting && (waitStart || this.quiet.has(key))) {
      item = await this.waitItem(object);
      if (item?.auto === true) {
        this.quiet.set(key, object);
        waitingOn = false;
      } else {
        this.quiet.delete(key);
        waitingOn = true;
      }
    } else if (!next.waiting) {
      this.quiet.delete(key);
    }
    const ended = next.final && previous?.final !== true;
    const looped = this.countVisit(key, next, stateChanged, waitStart || ended);
    // What happened, in order of weight; a kind that is not listed sends only
    // when `changes` is, which sends every state change and wait.
    const kind: ChannelReason | undefined = ended
      ? "ended"
      : waitingOn
        ? "waiting"
        : looped
          ? "loop"
          : undefined;
    const every =
      this.notify.has("changes") && (stateChanged || waitingOn) && !this.quiet.has(key);
    if (kind === undefined && !every) return;
    const reason: ChannelReason = kind ?? "changes";
    if (kind !== undefined && !this.notify.has(kind) && !every) return;
    const lastSent = this.pendingSent.get(key) ?? this.sent.get(key);
    // A loop is counted in memory, so it is never a repeat of a sent row.
    if (reason !== "loop" && lastSent !== undefined && sameRow(lastSent, next)) {
      return;
    }
    const notification = notificationOf(
      object.type,
      row,
      previous?.state ?? "new",
      await this.stepOf(object),
      reason,
      next.waiting ? item?.prompt : undefined,
    );
    const entry: Held = { notification, key, row: next };
    if (this.held !== undefined) {
      this.held.push(entry);
      // Held, not yet delivered: later changes still compare against it.
      this.pendingSent.set(key, next);
    } else {
      await this.deliver(entry);
    }
  }
}

interface RunStamp {
  readonly time: number;
  readonly started: number;
  readonly seq: number;
  readonly runId: string;
}

/** Whether `a` is the later run: ties on time break on start, seq, then id. */
function laterRun(a: RunStamp, b: RunStamp): boolean {
  if (a.time !== b.time) return a.time > b.time;
  if (a.started !== b.started) return a.started > b.started;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.runId > b.runId;
}

/**
 * Starts the channel after reading the starting rows, and subscribes to the
 * store. Call `close` when the server stops reading stdin.
 */
export async function startClaudeChannel(
  options: ChannelOptions,
): Promise<ChannelHandle> {
  const channel = new ClaudeChannel(options);
  await channel.start();
  return channel;
}
