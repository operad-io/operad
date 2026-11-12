/** Reads the text a command takes on standard input. */

/** The stream a command reads: stdin, or a test's stand-in. */
export type StdinStream = AsyncIterable<Uint8Array | string> & {
  readonly destroy?: (() => void) | undefined;
};

/** What a bounded read may inject: its deadline, clock, wait and stream. */
export interface StdinReadOptions {
  /** How long to wait before giving up; unset waits for the end of input. */
  readonly timeoutMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** The stream to read; defaults to the process's standard input. */
  readonly stream?: StdinStream | undefined;
}

/** What a bounded read found: the text, and whether its deadline passed first. */
export interface StdinRead {
  readonly text: string;
  readonly timedOut: boolean;
}

async function collect(stream: StdinStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads standard input with a deadline. A stream that never ends is stopped
 * when the deadline passes, so the caller gets an answer instead of waiting
 * forever. The clock and wait are injectable; production uses real time.
 */
export async function readStdinWithin(
  input: string | undefined,
  options: StdinReadOptions = {},
): Promise<StdinRead> {
  if (input !== undefined) return { text: input, timedOut: false };
  const stream = options.stream ?? process.stdin;
  // A terminal has no piped request: an empty text is the only safe answer.
  if (options.stream === undefined && process.stdin.isTTY === true) {
    return { text: "", timedOut: false };
  }
  const reading = collect(stream);
  if (options.timeoutMs === undefined) {
    return { text: await reading, timedOut: false };
  }

  const clock = options.clock ?? (() => Date.now());
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = clock() + options.timeoutMs;
  const timeout = (async (): Promise<"timedOut"> => {
    while (clock() < deadline) {
      await wait(Math.max(1, deadline - clock()));
    }
    return "timedOut";
  })();
  const outcome = await Promise.race([
    reading.then((text) => ({ text, timedOut: false as const })),
    timeout.then(() => ({ text: "", timedOut: true as const })),
  ]);
  if (outcome.timedOut) {
    // The read is no longer wanted. Destroying the stream releases its handle;
    // its eventual result is ignored.
    try {
      stream.destroy?.();
    } catch {
      // The stream already ended.
    }
    void reading.catch(() => undefined);
  }
  return outcome;
}

/** Reads the text a command takes on standard input. */
export async function readStdinText(input?: string): Promise<string> {
  const read = await readStdinWithin(input);
  return read.text;
}
