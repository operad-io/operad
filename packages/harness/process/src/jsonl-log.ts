/**
 * Appends complete JSONL lines to the step's log. A full buffer is written
 * before the caller hands over more lines: `push` returns the pending write, so
 * a harness that outruns the disk cannot queue writes without limit.
 */

import { isRecord, type PluginLogger } from "@operad-io/engine";
import { systemClock, type Clock } from "@operad-io/engine/platform";

/** How much text one write carries before the caller must wait for it. */
export const FLUSH_CHARS = 16 * 1024;

/** The longest a line waits in the buffer before it is written. */
export const FLUSH_MS = 250;

/** The field every logged line carries: when the host received it, in epoch milliseconds. */
export const RECEIVED_AT = "receivedAt";

function receivedAtOf(line: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const at = value[RECEIVED_AT];
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** A line with its receipt time; a line that is not a JSON object is left as it is. */
export function withReceivedAt(line: string, at: number): string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(value) || receivedAtOf(line) !== undefined) return line;
  return JSON.stringify({ ...value, [RECEIVED_AT]: at });
}

export class JsonlLog {
  private buffer = "";
  private timer: unknown = undefined;
  private chain: Promise<void> = Promise.resolve();
  private wrote = false;
  private readonly logger: PluginLogger;
  private readonly clock: Clock;
  private readonly now: () => number;

  constructor(logger: PluginLogger, clock: Clock = systemClock, now: () => number = Date.now) {
    this.logger = logger;
    this.clock = clock;
    this.now = now;
  }

  /** The line as the host logs it: a JSON object gets `receivedAt` once. */
  stamp(line: string): string {
    return receivedAtOf(line) === undefined ? withReceivedAt(line, this.now()) : line;
  }

  /**
   * Adds one line. Once the buffer is full, returns the write to wait for; the
   * caller that awaits it keeps at most one buffered chunk and one write in
   * memory. Before that it returns nothing.
   */
  push(line: string): Promise<void> | undefined {
    this.buffer += `${this.stamp(line)}\n`;
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
