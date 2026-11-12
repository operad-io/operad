/**
 * The worker program with a fake `claude` behind the SDK, for the tests that
 * need a real process (see `fake-hooks.ts` for the variables).
 */

import { main } from "../src/worker.ts";
import { fakeHooks } from "./fake-hooks.ts";

await main(fakeHooks(process.env));
