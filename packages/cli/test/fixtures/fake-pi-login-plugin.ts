import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiHarnessPlugin } from "@operad-io/harness-pi";

// The pi harness with the fake login child: no pi library and no network.
export default createPiHarnessPlugin({
  loginCommand: process.execPath,
  loginArgs: [fileURLToPath(new URL("../../../harness/pi/test/fake-login-worker.ts", import.meta.url))],
  piSettingsPath: join(process.env["OPERAD_HOME"] ?? import.meta.dir, "pi-settings.json"),
});
