import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHome } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const sourcePluginPath = fileURLToPath(
  new URL("../fixtures/plugins/source-probe.ts", import.meta.url),
);

describe("opening a home", () => {
  test("the kernel it opens gives its sources the same views the client uses", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [sourcePluginPath],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    const opened = await openHome({ home, cwd: home, onLog: () => undefined });
    try {
      await opened.kernel.startSources();
      expect(readFileSync(join(home, "source-probe.txt"), "utf8")).toBe(
        "function:function",
      );
    } finally {
      await opened.kernel.stopSources();
      opened.views.close();
      await opened.log.close();
    }
  });
});
