/**
 * The worker program with a fake `claude` behind the SDK, for the tests.
 *
 * - `FAKE_SCRIPT`: a JSON `FakeScript` (see `fake-claude.ts`).
 * - `FAKE_RECORD`: a file the fake appends what it saw to, one JSON line each.
 */

import { fakeSpawn, type FakeScript } from "./fake-claude.ts";
import { main } from "../src/worker.ts";

const script = JSON.parse(process.env["FAKE_SCRIPT"] ?? '{"steps":[]}') as FakeScript;

// FAKE_CLOCK_STEP: every reading of the clock moves on by this many milliseconds.
const step = Number(process.env["FAKE_CLOCK_STEP"] ?? "0");
let reading = 1_700_000_000_000;
const now = (): number => {
  const value = reading;
  reading += step;
  return value;
};

await main({
  spawnClaudeCodeProcess: fakeSpawn(script, process.env["FAKE_RECORD"]),
  ...(step > 0 ? { now } : {}),
});
