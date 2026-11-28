import { afterAll, expect, test } from "bun:test";
import { sharedOptionalPlugins, sharedStandInPlugins, OPTIONAL_PLUGINS_ENV, STAND_IN_PLUGINS_ENV } from "@operad-io/engine";
import { runMcpServer } from "../src/server.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

test("the lists the server is given reach the processes started from it", async () => {
  const previous = [OPTIONAL_PLUGINS_ENV, STAND_IN_PLUGINS_ENV].map((name) => [name, process.env[name]] as const);
  for (const [name] of previous) delete process.env[name];
  try {
    const home = await tempRoot();
    await runMcpServer({
      home,
      cwd: home,
      optional: { later: "@operad-io/later" },
      standIns: { "@operad-io/later": "/stand-in.ts" },
      input: (async function* () {})(),
      write: () => undefined,
      error: () => undefined,
    });
    expect(sharedOptionalPlugins()).toEqual({ later: "@operad-io/later" });
    expect(sharedStandInPlugins()).toEqual({ "@operad-io/later": "/stand-in.ts" });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
