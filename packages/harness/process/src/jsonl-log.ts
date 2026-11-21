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

/** The parsed line when it is one JSON object; undefined for anything else. */
function objectOf(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isRecord(value) ? value : undefined;
}

/** The receipt time already on a parsed line, when it has one. */
function receivedAtOf(value: Record<string, unknown> | undefined): number | undefined {
  const at = value?.[RECEIVED_AT];
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** A line as the host logs it, with the parse kept so a caller need not do it again. */
export interface StampedLine {
  readonly text: string;
  readonly value: Record<string, unknown> | undefined;
  readonly at: number;
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

  /**
   * The line as the host logs it: a JSON object gets `receivedAt` once. The
   * parsed object and the receipt time come back too, so the caller need not
   * parse the line again for its timings or its result.
   */
  stamp(line: string): StampedLine {
    const value = objectOf(line);
    const existing = receivedAtOf(value);
    const at = existing ?? this.now();
    if (value === undefined || existing !== undefined) return { text: line, value, at };
    return { text: JSON.stringify({ ...value, [RECEIVED_AT]: at }), value, at };
  }

  /** Adds one line the caller already stamped, returning the write to wait for once the buffer is full. */
  pushStamped(stamped: StampedLine): Promise<void> | undefined {
    return this.add(stamped.text);
  }

  private add(line: string): Promise<void> | undefined {
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
