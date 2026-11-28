// `operad serve` with the package command replaced: `ok` writes the pinned pi
// into the home's plugin project, as Bun would; `fail` ends as a download that
// did not happen.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PI_CODING_AGENT_PACKAGE, PI_CODING_AGENT_VERSION } from "../../src/defaults.ts";
import { main } from "../../src/main.ts";

const outcome = process.argv[2];

process.exitCode = await main(["serve"], {
  pluginInstall: (cwd) => {
    if (outcome === "fail") {
      return { exitCode: 1, stdout: "", stderr: "error: getaddrinfo ENOTFOUND registry.npmjs.org\n" };
    }
    writeFileSync(
      join(cwd, "node_modules", PI_CODING_AGENT_PACKAGE, "package.json"),
      JSON.stringify({
        name: PI_CODING_AGENT_PACKAGE,
        version: PI_CODING_AGENT_VERSION,
        exports: { ".": "./dist/index.js" },
      }),
    );
    return { exitCode: 0, stdout: "", stderr: "" };
  },
});
