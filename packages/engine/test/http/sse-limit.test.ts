import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SSE_EVENT_BYTES, type ViewEvent } from "../../src/index.ts";
import { EventHub, eventResponse } from "../../src/http/server.ts";

const fixtures = join(import.meta.dir, "..", "fixtures", "sse");

interface SseBlock {
  readonly raw: string;
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

interface StreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  cancel(): Promise<void>;
}

/** Reads one response body as raw event blocks, so a test can check every line. */
class SseReader {
  private readonly reader: StreamReader;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    const body = response.body;
    if (body === null) throw new Error("the event stream has no body");
    this.reader = body.getReader();
  }

  async next(): Promise<SseBlock> {
    for (;;) {
      const at = this.buffer.indexOf("\n\n");
      if (at >= 0) {
        const raw = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 2);
        const block = parseBlock(raw);
        if (block !== undefined) return block;
        continue;
      }
      const read = await within(this.reader.read());
      if (read.done) throw new Error("the event stream ended before an event");
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

/** Fails instead of letting a broken stream hang the test. */
function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an event")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseBlock(raw: string): SseBlock | undefined {
  if (raw.trimStart().startsWith(":")) return undefined;
  let id: string | undefined;
  let event: string | undefined;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data = data.length === 0 ? value : `${data}\n${value}`;
  }
  return id === undefined && event === undefined && data === ""
    ? undefined
    : { raw, id, event, data };
}

/** A source the test pushes into once the stream has subscribed. */
class Source {
  private readonly events: ViewEvent[] = [];
  private wake: (() => void) | undefined;
  private stopped = false;

  readonly source = (): AsyncIterable<ViewEvent> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<ViewEvent> => ({
      next: async (): Promise<IteratorResult<ViewEvent>> => {
        for (;;) {
          const event = this.events.shift();
          if (event !== undefined) return { done: false, value: event };
          if (this.stopped) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
        }
      },
      return: async (): Promise<IteratorResult<ViewEvent>> => {
        this.stop();
        return { done: true, value: undefined };
      },
    }),
  });

  push(event: ViewEvent): void {
    this.events.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  stop(): void {
    this.stopped = true;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

function open(source: Source): { readonly hub: EventHub; readonly reader: SseReader } {
  const hub = new EventHub(source.source, 10, () => undefined);
  const response = eventResponse(
    new Request("http://localhost/v1/events"),
    hub,
    60_000,
    100,
    "a-token",
    () => () => undefined,
  );
  return { hub, reader: new SseReader(response) };
}

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

function fixtureEvent(name: string): ViewEvent {
  const text = fixture(name);
  const raw = text.endsWith("\n\n") ? text.slice(0, -2) : text;
  const block = parseBlock(raw);
  if (block === undefined) throw new Error(`${name} holds no event`);
  return JSON.parse(block.data) as ViewEvent;
}

/** The server's line bound, checked over the raw bytes of one event block. */
function expectLinesWithinLimit(raw: string): void {
  for (const line of raw.split("\n")) {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_SSE_EVENT_BYTES);
  }
}

describe("SSE event size", () => {
  test("a tail at the line limit goes through as one tail event", async () => {
    const source = new Source();
    const stream = open(source);
    try {
      const event = fixtureEvent("tail-at-limit.sse");
      source.push(event);
      const block = await stream.reader.next();
      expectLinesWithinLimit(block.raw);
      expect(block.event).toBe("tail");
      expect(block.id).toBeUndefined();
      expect(`${block.raw}\n\n`).toBe(fixture("tail-at-limit.sse"));
    } finally {
      await stream.reader.close();
      stream.hub.stop();
      source.stop();
    }
  });

  test("a tail one byte over is dropped, and the growth change asks for the reread", async () => {
    const source = new Source();
    const stream = open(source);
    try {
      const event = fixtureEvent("tail-one-byte-over.sse");
      const encoded = `data: ${JSON.stringify(event)}`;
      expect(Buffer.byteLength(encoded, "utf8")).toBe(MAX_SSE_EVENT_BYTES + 1);

      // A live part comes beside the object's change event; the hub drops the
      // oversized part instead of turning it into a second, replayable change.
      source.push(event);
      const next: ViewEvent = {
        id: "chat-2",
        type: "chat",
        section: "transcript",
        tail: "small",
      };
      source.push(next);
      const block = await stream.reader.next();
      expectLinesWithinLimit(block.raw);
      expect(block.event).toBe("tail");
      expect(JSON.parse(block.data)).toEqual(next);

      source.push({ id: event.id });
      const change = await stream.reader.next();
      expectLinesWithinLimit(change.raw);
      expect(change.event).toBeUndefined();
      expect(change.id).toBeDefined();
      expect(JSON.parse(change.data)).toEqual({ id: event.id });
    } finally {
      await stream.reader.close();
      stream.hub.stop();
      source.stop();
    }
  });

  test("no line of a random tail exceeds the limit, including multi-byte UTF-8", async () => {
    const source = new Source();
    const stream = open(source);
    let state = 0x51f15e;
    const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 2 ** 32;
    };
    const pieces = ["a", "Z", "0", " ", "\n", "\t", "é", "中", "😀"];
    try {
      for (let index = 0; index < 32; index += 1) {
        const count = index < 2 ? index : Math.floor(random() * 90_000);
        const parts: string[] = [];
        for (let part = 0; part < count; part += 1) {
          parts.push(pieces[Math.floor(random() * pieces.length)] ?? "a");
        }
        const event: ViewEvent = {
          id: "chat-1",
          type: "chat",
          section: "transcript",
          tail: parts.join(""),
        };
        const fits =
          Buffer.byteLength(`data: ${JSON.stringify(event)}`, "utf8") <=
          MAX_SSE_EVENT_BYTES;
        source.push(event);
        // An oversized part is dropped, so a small live part after it is the
        // first block the stream writes; it proves no long line was written.
        const marker: ViewEvent = {
          id: "chat-2",
          type: "chat",
          section: "transcript",
          tail: `marker ${index}`,
        };
        if (!fits) source.push(marker);
        const block = await stream.reader.next();
        expectLinesWithinLimit(block.raw);
        if (fits) {
          expect(block.event).toBe("tail");
          expect(JSON.parse(block.data)).toEqual(event);
        } else {
          expect(block.event).toBe("tail");
          expect(JSON.parse(block.data)).toEqual(marker);
        }
      }
    } finally {
      await stream.reader.close();
      stream.hub.stop();
      source.stop();
    }
  });

  test("an ordinary change event stays within the same line bound", async () => {
    const source = new Source();
    const stream = open(source);
    try {
      const id = "item-".padEnd(4_096, "x");
      source.push({ id });
      const block = await stream.reader.next();
      expectLinesWithinLimit(block.raw);
      expect(block.event).toBeUndefined();
      expect(block.id).toBeDefined();
      expect(JSON.parse(block.data)).toEqual({ id });
    } finally {
      await stream.reader.close();
      stream.hub.stop();
      source.stop();
    }
  });

  test("a change id too long to fit becomes a reset instead of a long line", async () => {
    const source = new Source();
    const stream = open(source);
    try {
      source.push({ id: "item-".padEnd(MAX_SSE_EVENT_BYTES + 10, "x") });
      const block = await stream.reader.next();
      expectLinesWithinLimit(block.raw);
      expect(block.event).toBe("reset");
      expect(block.data).toBe("{}");
    } finally {
      await stream.reader.close();
      stream.hub.stop();
      source.stop();
    }
  });

  test("the shared fixtures carry the limits and streams client tests reuse", () => {
    const atLimit = fixture("tail-at-limit.sse");
    const atLines = atLimit.split("\n");
    expect(Math.max(...atLines.map((line) => Buffer.byteLength(line, "utf8")))).toBe(
      MAX_SSE_EVENT_BYTES,
    );

    const over = fixture("tail-one-byte-over.sse");
    const overLines = over.split("\n");
    expect(Math.max(...overLines.map((line) => Buffer.byteLength(line, "utf8")))).toBe(
      MAX_SSE_EVENT_BYTES + 1,
    );

    const long = fixture("long-line-without-newline.sse");
    expect(long.includes("\n")).toBe(false);
    expect(Buffer.byteLength(long, "utf8")).toBe(MAX_SSE_EVENT_BYTES + 1);

    const split = fixture("frame-split-across-chunks.sse");
    expect(split).toContain("\r\n");
    expect(split).toContain("event: tail\r\n");
    for (const line of split.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_SSE_EVENT_BYTES);
    }

    const reset = fixture("reset-after-reconnect.sse");
    expect(reset).toContain("event: reset\ndata: {}\n\n");
  });
});
