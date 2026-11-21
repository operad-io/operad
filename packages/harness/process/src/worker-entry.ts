/**
 * The process entry every child program shares: stdin in, stdout lines out,
 * the exit code out. A program supplies its adapter and what its own runtime
 * needs removed or ignored.
 */

import { existsSync } from "node:fs";
import { serveKeptWorker, type ParsedInput, type WorkerAdapter } from "./keep.ts";

/** Reads one input object; invalid JSON is a parse failure. */
export function decodeWorkerInput<TInput>(
  text: string,
  parse: (value: unknown) => ParsedInput<TInput>,
): ParsedInput<TInput> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, message: "the input is not valid JSON" };
  }
  return parse(decoded);
}

/** What a plugin's `check` knows about its worker program. */
export interface WorkerAvailability {
  /** The executable a test injected; the running Bun when it is unset. */
  readonly command?: string | undefined;
  /** The arguments a test injected; the worker program when they are unset. */
  readonly args?: readonly string[] | undefined;
  /** The worker program the plugin starts. */
  readonly workerPath: string;
}

/** Refuses `check` when the running Bun or the worker program is not there. */
export function assertWorkerAvailable(availability: WorkerAvailability): void {
  if (availability.command === undefined && !existsSync(process.execPath)) {
    throw new Error("bun was not found");
  }
  if (availability.args === undefined && !existsSync(availability.workerPath)) {
    throw new Error(`the worker program is missing: ${availability.workerPath}`);
  }
}

/** What a program's entry needs beyond its adapter. */
export interface WorkerMainOptions {
  /** Environment variables the program's own runtime must not see. */
  readonly envToDelete?: readonly string[] | undefined;
  /** True when a closed stdout or stderr must not fail the program. */
  readonly ignoreStreamErrors?: boolean | undefined;
}

/** The process entry: stdin in, stdout lines out, exit code out. */
export async function runWorkerMain<TInput>(
  adapter: WorkerAdapter<TInput>,
  options: WorkerMainOptions = {},
): Promise<never> {
  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      process.stdout.write("", () => resolve());
    });
  // Anything that prints to stdout by accident would corrupt the protocol.
  console.log = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };
  for (const name of options.envToDelete ?? []) delete process.env[name];

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  if (options.ignoreStreamErrors === true) {
    process.stdout.on("error", () => undefined);
    process.stderr.on("error", () => undefined);
  }
  const code = await serveKeptWorker(
    Bun.stdin.stream(),
    {
      write: (text) => {
        process.stdout.write(text);
      },
      log: (text) => process.stderr.write(`${text}\n`),
    },
    controller.signal,
    adapter,
  );
  await flush();
  process.exit(code);
}
