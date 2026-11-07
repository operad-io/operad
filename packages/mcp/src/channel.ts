/**
 * The Claude Code channel: one-way change notifications beside the read tools.
 *
 * The store's object subscription is the source. A watch is the fast path and
 * the store's own timer is the fallback, so a change another process writes is
 * seen too. The server remembers the row it last saw for each object and sends
 * only when its state, waiting or running flag differs.
 */

import {
  messageOf,
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
  "Changes arrive as `<channel>` blocks, one per change, with the meta attributes `id`, `type`, `state`, `previous`, `waiting` and `running`. They are one-way: there is no reply tool. Read the details with `show`, `section`, `pending` and `history`.";

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
  };
}

/** What a channel needs: the views, the store's subscription and one writer. */
export interface ChannelOptions {
  readonly views: Views;
  readonly registry: PluginRegistry;
  /** The object types to report; the default is every type with views. */
  readonly types?: readonly string[] | undefined;
  readonly send: (
    notification: ChannelNotification,
  ) => void | Promise<void>;
  readonly onLog?: ((message: string) => void) | undefined;
}

/** A running channel. Closing it stops the subscription and waits for sends. */
export interface ChannelHandle {
  close(): Promise<void>;
}

interface SeenRow {
  readonly state: string;
  readonly waiting: boolean;
  readonly running: boolean;
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
  private stop: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: ChannelOptions) {
    this.views = options.views;
    this.registry = options.registry;
    this.types =
      options.types === undefined
        ? new Set(
            this.registry
              .objectTypes()
              .map((entry) => entry.type)
              .filter((type) => this.registry.viewsFor(type) !== undefined),
          )
        : new Set(options.types);
    this.sendNotification = options.send;
    this.onLog = options.onLog ?? ((message) => console.error(message));
  }

  async start(): Promise<void> {
    for (const type of this.types) {
      try {
        await this.seed(type);
      } catch (error) {
        this.onLog(
          `channel: the starting rows of "${type}" could not be read: ${messageOf(error)}`,
        );
      }
    }
    if (this.closed) return;
    this.stop = this.registry.store.subscribe((object) => {
      this.enqueue(object);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop?.();
    this.stop = undefined;
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

  private async handle(object: ObjectRef): Promise<void> {
    if (this.closed || !this.types.has(object.type)) return;
    let current: ViewObject;
    try {
      current = await this.views.get(`${object.type}:${object.id}`);
    } catch (error) {
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
    if (previous !== undefined && sameRow(previous, next)) return;
    await this.sendNotification(
      notificationOf(object.type, row, previous?.state ?? "new"),
    );
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
