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
    const store = new FilePluginStore({ root: join(root, "store", "plugins") });
    for (let index = 0; index < 4000; index += 1) {
      store.put(
        "item",
        `row-${index}`,
        { title: `A title long enough to fill the pipe, row ${index}`, state: "new" },
        "seed",
      );
    }

    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "list", "item", "--limit", "4000"],
      env: { ...process.env, OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const errText = new Response(child.stderr).text();

    // Read until the first line is complete, then close the reader: the rest
    // of the output meets a closed pipe.
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
    expect(seen).toContain("\n");
    await reader.cancel();

    const code = await child.exited;
    expect(await errText).toBe("");
    expect(code).toBe(141);
  }, 60000);
});
