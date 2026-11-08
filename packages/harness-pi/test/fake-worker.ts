/**
 * The worker program with a fake model registered, for the tests.
 *
 * A model cannot travel over the stdin protocol, so this entry runs the same
 * `main` as `src/worker.ts` and adds the fake provider through its hook. The
 * environment says what the fake model does:
 *
 * - `FAKE_SCRIPT`: a JSON array of responses, one per model call; an entry is
 *   `{ text, cost?, noPrice?, hang?, toolCall? }`. `hang` never finishes
 *   until pi aborts it.
 * - `FAKE_CONTEXT_FILE`: each call's messages are appended to it, one JSON
 *   line per call.
 *
 * It writes `fake-stream-started` to stderr when a call begins.
 */

import { appendFileSync } from "node:fs";
import { FakeProvider, type FakeResponse, type FakeToolCall } from "./fake-provider.ts";
import { main } from "../src/worker.ts";

interface ScriptEntry {
  text: string;
  cost?: number;
  noPrice?: boolean;
  hang?: boolean;
  toolCall?: FakeToolCall;
}

const provider = new FakeProvider();
const script = JSON.parse(process.env["FAKE_SCRIPT"] ?? "[]") as ScriptEntry[];
for (const entry of script) {
  const response: FakeResponse = { text: entry.text };
  if (entry.cost !== undefined) response.cost = entry.cost;
  if (entry.noPrice === true) response.noPrice = true;
  if (entry.toolCall !== undefined) response.toolCall = entry.toolCall;
  if (entry.hang === true) response.before = new Promise<void>(() => {});
  provider.enqueue(response);
}

const contextFile = process.env["FAKE_CONTEXT_FILE"];
provider.onStream = () => {
  const context = provider.contexts.at(-1);
  if (contextFile !== undefined && context !== undefined) {
    appendFileSync(contextFile, `${JSON.stringify(context.messages)}\n`);
  }
  process.stderr.write("fake-stream-started\n");
};

// FAKE_CLOCK_STEP: every reading of the clock moves on by this many milliseconds.
const step = Number(process.env["FAKE_CLOCK_STEP"] ?? "0");
let reading = 1_700_000_000_000;
const now = (): number => {
  const value = reading;
  reading += step;
  return value;
};

await main({ registerProviders: (runtime) => provider.register(runtime), ...(step > 0 ? { now } : {}) });
