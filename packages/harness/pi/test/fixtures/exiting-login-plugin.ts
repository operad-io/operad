/** The pi plugin as a file a step worker loads, with a login child that ends early. */

import { fileURLToPath } from "node:url";
import { createPiHarnessPlugin } from "../../src/index.ts";

export default createPiHarnessPlugin({
  loginArgs: [fileURLToPath(new URL("../fake-exiting-login-worker.ts", import.meta.url))],
  // The login's own clock stands still, so its time limit cannot end it.
  now: () => 0,
});
