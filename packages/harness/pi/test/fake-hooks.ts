/**
 * The worker's hooks with a fake model registered, read from an environment the
 * way `fake-worker.ts` reads the process's own. The environment says what the
 * fake model does:
 *
 * - `FAKE_SCRIPT`: a JSON array of responses, one per model call; an entry is
 *   `{ text, thinking?, cost?, noPrice?, hang?, gate?, endless?, toolCall? }`.
 *   `hang` never finishes until pi aborts it; `gate` waits for the file named by
 *   `FAKE_RELEASE`; `endless` streams its content and then never finishes.
 * - `FAKE_CONTEXT_FILE`: each call's messages are appended to it, one JSON
 *   line per call.
 * - `FAKE_CLOCK_STEP`: every reading of the clock moves on by this many milliseconds.
 *
 * `log` gets `fake-stream-started` when a call begins.
 */

import { appendFileSync } from "node:fs";
import { waitForRelease } from "@operad-io/harness-process/test-fake-lines";
import type { WorkerHooks } from "../src/worker.ts";
import { FakeProvider, type FakeResponse, type FakeToolCall } from "./fake-provider.ts";

interface ScriptEntry {
  text: string;
  thinking?: string;
  cost?: number;
  noPrice?: boolean;
  hang?: boolean;
  /** Waits for the file named by `FAKE_RELEASE` to exist before it answers. */
  gate?: boolean;
  /** Streams its content and then never finishes; an abort ends it. */
  endless?: boolean;
  toolCall?: FakeToolCall;
}

export function fakeHooks(
  env: Readonly<Record<string, string | undefined>>,
  log: (text: string) => void = (text) => void process.stderr.write(text),
): WorkerHooks {
  const provider = new FakeProvider();
  const script = JSON.parse(env["FAKE_SCRIPT"] ?? "[]") as ScriptEntry[];
  for (const entry of script) {
    const response: FakeResponse = { text: entry.text };
    if (entry.thinking !== undefined) response.thinking = entry.thinking;
    if (entry.cost !== undefined) response.cost = entry.cost;
    if (entry.noPrice === true) response.noPrice = true;
    if (entry.toolCall !== undefined) response.toolCall = entry.toolCall;
    if (entry.hang === true) response.before = new Promise<void>(() => {});
    if (entry.gate === true) response.before = waitForRelease(env["FAKE_RELEASE"]);
    if (entry.endless === true) response.endless = true;
    provider.enqueue(response);
  }

  const contextFile = env["FAKE_CONTEXT_FILE"];
  provider.onStream = () => {
    const context = provider.contexts.at(-1);
    if (contextFile !== undefined && context !== undefined) {
      appendFileSync(contextFile, `${JSON.stringify(context.messages)}\n`);
    }
    log("fake-stream-started\n");
  };
  provider.onEndless = () => log("fake-stream-endless\n");

  const step = Number(env["FAKE_CLOCK_STEP"] ?? "0");
  let reading = 1_700_000_000_000;
  const now = (): number => {
    const value = reading;
    reading += step;
    return value;
  };

  return { registerProviders: (runtime) => provider.register(runtime), ...(step > 0 ? { now } : {}) };
}
