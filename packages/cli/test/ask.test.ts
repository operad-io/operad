import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openConfigLog, readConfig } from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/ask.ts", import.meta.url),
);

function capture(): { io: CliIo; text(): string } {
  let out = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: () => undefined,
    },
    text: () => out,
  };
}

describe("ask.graceSecs in config.json", () => {
  test("a grace of 0 sends the question to the person at once", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [pluginPath],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        ask: { graceSecs: 0 },
      }),
    );
    writeFileSync(
      join(home, "triggers.json"),
      JSON.stringify([
        {
          source: "cron",
          type: "tick",
          start: { flow: "ask-wait", params: { name: "c", dir: root } },
          object: "job:1",
          mode: "auto",
        },
      ]),
    );
    expect(
      await main(["trigger", "cron", "tick:1", "--type", "tick"], { home, io: capture().io }),
    ).toBe(0);
    const log = openConfigLog(await readConfig(home));
    const runs = await log.runs();
    await log.close();
    const runId = runs[0]?.runId;
    if (runId === undefined) throw new Error("no run");

    expect(await main(["run-internal", runId], { home, io: capture().io })).toBe(0);

    const pending = capture();
    expect(await main(["pending"], { home, io: pending.io })).toBe(0);
    expect(pending.text()).toContain("Delete the stale branch?");
    const history = capture();
    expect(await main(["history", runId], { home, io: history.io })).toBe(0);
    expect(history.text()).toContain("nobody answered in time");
  }, 30_000);
});
