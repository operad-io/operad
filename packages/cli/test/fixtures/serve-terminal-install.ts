// `operad serve` as on a machine whose home does not have the terminal package:
// the checkout's own copy does not resolve, so the stand-in loads. The download
// says it started, and fails once the file `fail-download` is in the home.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "@operad-io/engine/testing";
import { main } from "../../src/main.ts";

const resolveSync = Bun.resolveSync;
Bun.resolveSync = (specifier, from) => {
  if (specifier === "@operad-io/terminal") throw new Error(`Cannot find package "${specifier}"`);
  return resolveSync(specifier, from);
};

const home = process.env.OPERAD_HOME ?? "";

process.exitCode = await main(["serve"], {
  pluginInstall: async () => {
    process.stdout.write("download started\n");
    await waitUntil(() => existsSync(join(home, "fail-download")), 20_000);
    return { exitCode: 1, stdout: "", stderr: "error: getaddrinfo ENOTFOUND registry.npmjs.org\n" };
  },
});
