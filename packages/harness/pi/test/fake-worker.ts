/**
 * The worker program with a fake model registered, for the tests that need a
 * real process (see `fake-hooks.ts` for the variables).
 *
 * A model cannot travel over the stdin protocol, so this entry runs the same
 * `main` as `src/worker.ts` and adds the fake provider through its hook.
 */

import { main } from "../src/worker.ts";
import { fakeHooks } from "./fake-hooks.ts";

await main(fakeHooks(process.env));
