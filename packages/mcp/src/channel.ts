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

import {
  messageOf,
  ViewError,
  type LogBackend,
  type ObjectRef,
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
  "Changes arrive as `<channel>` blocks, one per change, with the meta attributes `id`, `type`, `state`, `previous`, `waiting` and `running`, and `step` while the object has an active run. A block is sent when the state changes or something starts waiting for a person; a flag flipping alone sends nothing. They are one-way: there is no reply tool. Read the details with `show`, `section`, `pending` and `history`.";

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
    /** The active run's last step; absent when the object has no active run. */
    readonly step?: string;
  };
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

function contentOf(row: ViewRow, previous: string): string {
  const note =
    typeof row.note === "string" && row.note.trim().length > 0
      ? `: ${oneLine(row.note)}`
      : "";
  return `${oneLine(row.id)} ${previous} -> ${oneLine(row.state)}${note}`;
}

function notificationOf(
  type: string,
  row: ViewRow,
  previous: string,
  step: string | undefined,
): ChannelNotification {
  return {
    content: contentOf(row, previous),
    meta: {
      id: oneLine(row.id),
      type,
      state: oneLine(row.state),
      previous: oneLine(previous),
      waiting: row.waiting ? "true" : "false",
      running: row.running ? "true" : "false",
      ...(step === undefined ? {} : { step: oneLine(step) }),
    },
  };
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
  /** The row each object's last block (or starting row) reported. */
  private readonly sent = new Map<string, SeenRow>();
  private readonly log: LogBackend | undefined;
  /** Types whose starting rows could not be read: a first sighting is a baseline. */
  private readonly unseeded = new Set<string>();
  private held: ChannelNotification[] | undefined;
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
    this.log = options.log;
    this.held = options.hold === true ? [] : undefined;
    this.sendNotification = options.send;
    this.onLog = options.onLog ?? ((message) => console.error(message));
  }

  async start(): Promise<void> {
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
      for (const notification of held ?? []) {
        if (this.closed) return;
        await this.sendNotification(notification);
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
        this.sent.set(rowKey(type, row.id), seenRow(row));
      }
      if (page.next === undefined) return;
      cursor = page.next;
    }
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
      const run = runs.find((entry) => entry.object === key);
      if (run === undefined) return undefined;
      let step: string | undefined;
      for await (const fact of this.log.read(run.runId)) {
        const payload = fact.payload;
        if (
          fact.kind === "step_entered" &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload.kind !== "end" &&
          typeof payload.step === "string"
        ) {
          step = payload.step;
        }
      }
      return step;
    } catch (error) {
      this.onLog(`channel: the step of "${object.type}:${object.id}" could not be read: ${messageOf(error)}`);
      return undefined;
    }
  }

  private async handle(object: ObjectRef): Promise<void> {
    if (this.closed || !this.types.has(object.type)) return;
    let current: ViewObject;
    try {
      current = await this.views.get(`${object.type}:${object.id}`);
    } catch (error) {
      if (error instanceof ViewError && error.kind === "not-found") {
        // A deleted object: forget it, so a new one with the same id is new.
        this.last.delete(rowKey(object.type, object.id));
        this.sent.delete(rowKey(object.type, object.id));
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
    if (previous !== undefined) {
      const stateChanged = previous.state !== next.state;
      const waitingOn = next.waiting && !previous.waiting;
      if (!stateChanged && !waitingOn) return;
    }
    const lastSent = this.sent.get(key);
    if (lastSent !== undefined && sameRow(lastSent, next)) return;
    this.sent.set(key, next);
    const notification = notificationOf(
      object.type,
      row,
      previous?.state ?? "new",
      await this.stepOf(object),
    );
    if (this.held !== undefined) this.held.push(notification);
    else await this.sendNotification(notification);
  }
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
