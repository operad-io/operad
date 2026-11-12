/**
 * Appends complete JSONL lines to the step's log. A full buffer is written
 * before the caller hands over more lines: `push` returns the pending write, so
 * a harness that outruns the disk cannot queue writes without limit.
 */

import type { PluginLogger } from "@operad-io/engine";
import { systemClock, type Clock } from "@operad-io/engine/platform";

/** How much text one write carries before the caller must wait for it. */
export const FLUSH_CHARS = 16 * 1024;

/** The longest a line waits in the buffer before it is written. */
export const FLUSH_MS = 250;

export class JsonlLog {
  private buffer = "";
  private timer: unknown = undefined;
  private chain: Promise<void> = Promise.resolve();
  private wrote = false;
  private readonly logger: PluginLogger;
  private readonly clock: Clock;

  constructor(logger: PluginLogger, clock: Clock = systemClock) {
    this.logger = logger;
    this.clock = clock;
  }

  /**
   * Adds one line. Once the buffer is full, returns the write to wait for; the
   * caller that awaits it keeps at most one buffered chunk and one write in
   * memory. Before that it returns nothing.
   */
  push(line: string): Promise<void> | undefined {
    this.buffer += `${line}\n`;
    if (this.buffer.length >= FLUSH_CHARS) return this.flush();
    // A short buffer is written within FLUSH_MS of its first line.
    if (this.timer === undefined) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        // A failed write is raised by `end`, which waits for the chain.
        this.flush().catch(() => undefined);
      }, FLUSH_MS);
    }
    return undefined;
  }

  /** Writes the rest and waits for every queued write. */
  async end(): Promise<void> {
    this.flush();
    if (!this.wrote) {
      this.chain = this.chain.then(() => this.logger.write("")).then(() => undefined);
    }
    await this.chain;
  }

  private flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const text = this.buffer;
    this.buffer = "";
    if (text.length === 0) return this.chain;
    this.wrote = true;
    this.chain = this.chain
      .then(() => this.logger.write(text))
      .then(() => undefined);
    return this.chain;
  }
}
