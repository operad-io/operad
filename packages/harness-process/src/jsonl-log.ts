/**
 * Appends complete JSONL lines to the step's log. A full buffer is written
 * before the caller hands over more lines: `push` returns the pending write, so
 * a harness that outruns the disk cannot queue writes without limit.
 */

import type { PluginLogger } from "@operad-io/engine";

/** How much text one write carries before the caller must wait for it. */
export const FLUSH_CHARS = 16 * 1024;

export class JsonlLog {
  private buffer = "";
  private chain: Promise<void> = Promise.resolve();
  private wrote = false;
  private readonly logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  /**
   * Adds one line. Once the buffer is full, returns the write to wait for; the
   * caller that awaits it keeps at most one buffered chunk and one write in
   * memory. Before that it returns nothing.
   */
  push(line: string): Promise<void> | undefined {
    this.buffer += `${line}\n`;
    if (this.buffer.length < FLUSH_CHARS) return undefined;
    return this.flush();
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
