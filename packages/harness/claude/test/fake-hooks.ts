/**
 * The worker's hooks with a fake `claude` behind the SDK, read from an
 * environment the way `fake-worker.ts` reads the process's own:
 *
 * - `FAKE_SCRIPT`: a JSON `FakeScript` (see `fake-claude.ts`).
 * - `FAKE_RECORD`: a file the fake appends what it saw to, one JSON line each.
 * - `FAKE_CLOCK_STEP`: every reading of the clock moves on by this many milliseconds.
 */

import type { WorkerHooks } from "../src/worker.ts";
import { fakeSpawn, type FakeScript } from "./fake-claude.ts";

export function fakeHooks(
  env: Readonly<Record<string, string | undefined>>,
  log?: (text: string) => void,
): WorkerHooks {
  const script = JSON.parse(env["FAKE_SCRIPT"] ?? '{"steps":[]}') as FakeScript;
  const step = Number(env["FAKE_CLOCK_STEP"] ?? "0");
  let reading = 1_700_000_000_000;
  const now = (): number => {
    const value = reading;
    reading += step;
    return value;
  };
  return {
    spawnClaudeCodeProcess: fakeSpawn(script, env["FAKE_RECORD"], log),
    ...(step > 0 ? { now } : {}),
    env,
  };
}
