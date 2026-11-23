/**
 * Watching a chat's reply from a bot source: one read per check, no second
 * check while one runs, and a stopped watch that no longer reads. Both the
 * scheduled prompts and the nightly tidy end a reply this way.
 */

import { messageOf, type ObjectStore, type RunControl } from "@operad-io/engine";
import { CHAT_TYPE, readChat, writingReplyNow, type ChatRead } from "@operad-io/chat";

/** One chat's watch: how to stop it. */
interface ChatWatch {
  readonly stop: () => void;
  readonly recheck: () => void;
}

/** The watches of one bot source, and the work they and its polls started. */
export class ChatWatches {
  private readonly watches = new Map<string, ChatWatch>();
  private readonly work = new Set<Promise<void>>();

  constructor(
    private readonly logger: { write(text: string): Promise<string> },
    private readonly store: ObjectStore,
    private readonly runs?: RunControl | undefined,
  ) {}

  async log(message: string): Promise<void> {
    await this.logger.write(message);
  }

  track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => this.log(messageOf(error)))
      .finally(() => this.work.delete(tracked));
    this.work.add(tracked);
  }

  /** Waits for the checks that are running now; a test calls this after a reply. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  /** Reads every watched chat again: an end that leaves no new fact is found by it. */
  recheckAll(): void {
    for (const watch of [...this.watches.values()]) watch.recheck();
  }

  stopAll(): void {
    for (const watch of [...this.watches.values()]) watch.stop();
    this.watches.clear();
  }

  /**
   * Watches one chat until `ready` answers a value: a reply that is still
   * writing is not ready, and a watch stopped by its key or by `stopAll` reads
   * no more. `done` runs once, after the watch stopped.
   */
  watchChatReply<Value>(
    key: string,
    chatId: string,
    ready: (read: ChatRead) => Promise<Value | undefined> | Value | undefined,
    done: (value: Value) => Promise<void>,
  ): void {
    if (this.watches.has(key)) return;
    let running = false;
    let again = false;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    const check = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      if (stopped) return;
      running = true;
      try {
        const read = readChat(this.store, chatId);
        // A reply that goes round again is not finished at its first message.
        if ((await writingReplyNow(read.facts, read.messages, read.entries, this.runs)) !== undefined) return;
        const value = await ready(read);
        if (value === undefined) return;
        stopped = true;
        unsubscribe?.();
        this.watches.delete(key);
        await done(value);
      } finally {
        running = false;
        if (again && !stopped) {
          again = false;
          this.track(check());
        }
      }
    };
    const blocking: ChatWatch = {
      stop: () => {
        stopped = true;
        unsubscribe?.();
        this.watches.delete(key);
      },
      recheck: () => this.track(check()),
    };
    this.watches.set(key, blocking);
    unsubscribe = this.store.subscribe({ type: CHAT_TYPE, id: chatId }, {}, () => {
      this.track(check());
    });
    this.track(check());
  }
}
