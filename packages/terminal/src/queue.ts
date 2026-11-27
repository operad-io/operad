/**
 * The order of everything that goes through a headless terminal: output, and
 * the work that has to happen between two pieces of it. The terminal parses
 * later than it is written to and refuses writes once it is tens of megabytes
 * behind, so only so much is with it at a time; the rest waits here. When too
 * much waits, the oldest output is left out whole pieces at a time, for the
 * screen and for every reader alike, and the work keeps its place.
 */

/** The most output the terminal is given before it has parsed some. */
export const MAX_PARSING_CHARACTERS = 1024 * 1024;

/** The most output that waits for the terminal before the oldest is left out. */
export const MAX_WAITING_CHARACTERS = 8 * 1024 * 1024;

/** Where the output goes; `done` is called once it is parsed, in write order. */
export interface Sink {
  write(text: string, done: () => void): void;
}

export interface QueueOptions {
  /** Called once each time output starts to be left out. */
  readonly onDrop: () => void;
  readonly maxParsing?: number | undefined;
  readonly maxWaiting?: number | undefined;
}

type Item =
  | { readonly text: string; readonly parsed: () => void }
  | { readonly text?: undefined; readonly work: () => void };

export class OutputQueue {
  private waiting: Item[] = [];
  private waitingCharacters = 0;
  private parsingCharacters = 0;
  private dropping = false;
  private readonly maxParsing: number;
  private readonly maxWaiting: number;

  constructor(
    private readonly sink: Sink,
    private readonly options: QueueOptions,
  ) {
    this.maxParsing = options.maxParsing ?? MAX_PARSING_CHARACTERS;
    this.maxWaiting = options.maxWaiting ?? MAX_WAITING_CHARACTERS;
  }

  /** Writes one piece of output; `parsed` is called unless it is left out. */
  write(text: string, parsed: () => void): void {
    this.waiting.push({ text, parsed });
    this.waitingCharacters += text.length;
    this.pass();
    if (this.waitingCharacters > this.maxWaiting) this.leaveOut();
  }

  /** Runs `work` once all output written before it is parsed. */
  run(work: () => void): void {
    this.waiting.push({ work });
    this.pass();
  }

  private pass(): void {
    for (let next = this.waiting[0]; next !== undefined; next = this.waiting[0]) {
      if (next.text === undefined) {
        this.waiting.shift();
        this.sink.write("", next.work);
        continue;
      }
      const { text, parsed } = next;
      // A piece larger than the limit goes alone.
      if (this.parsingCharacters > 0 && this.parsingCharacters + text.length > this.maxParsing) return;
      this.waiting.shift();
      this.waitingCharacters -= text.length;
      this.parsingCharacters += text.length;
      this.sink.write(text, () => {
        this.parsingCharacters -= text.length;
        parsed();
        this.pass();
      });
    }
    this.dropping = false;
  }

  /** Leaves out the oldest output that waits, but never the newest piece. */
  private leaveOut(): void {
    const newest = this.waiting.findLastIndex((item) => item.text !== undefined);
    this.waiting = this.waiting.filter((item, index) => {
      if (item.text === undefined || index === newest) return true;
      if (this.waitingCharacters <= this.maxWaiting) return true;
      this.waitingCharacters -= item.text.length;
      if (!this.dropping) {
        this.dropping = true;
        this.options.onDrop();
      }
      return false;
    });
    // Work that waited behind what was left out may be first now.
    this.pass();
  }
}
