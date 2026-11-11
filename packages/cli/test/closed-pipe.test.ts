import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilePluginStore } from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

describe("a reader that closes the pipe", () => {
  test("list with more rows than the pipe holds: the reader reads one line and closes; status 141, nothing on stderr", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [pluginPath],
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );
    // One page of rows must be well past what a pipe buffers (64 KiB, and
    // more on some systems): a child whose whole output fits in the pipe
    // finishes before the reader closes, and exits 0 rightly.
    const store = new FilePluginStore({ root: join(root, "store", "plugins") });
    for (let index = 0; index < 4000; index += 1) {
      store.put(
        "item",
        `row-${index}`,
        { title: `${"A title long enough to fill the pipe. ".repeat(10)}row ${index}`, state: "new" },
        "seed",
      );
    }

    // A real shell pipe to a reader that takes one line and exits. Bun drains
    // a child's stdout into memory on its own, so with Bun.spawn the child
    // could finish before the test closed anything.
    const child = Bun.spawn({
      cmd: [
        "bash",
        "-c",
        '"$@" | { head -n 1 >/dev/null; }; exit "${PIPESTATUS[0]}"',
        "bash",
        process.execPath,
        CLI_ENTRY,
        "list",
        "item",
        "--limit",
        "4000",
      ],
      env: { ...process.env, OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const errText = new Response(child.stderr).text();

    const code = await child.exited;
    expect(await errText).toBe("");
    expect(code).toBe(141);
  }, 60000);
});
