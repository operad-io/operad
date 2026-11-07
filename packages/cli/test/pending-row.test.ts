import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilePluginStore, openConfigLog, readConfig } from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
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

async function waitingHome(
  objects: readonly string[],
): Promise<string> {
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
  store.put("item", "one", { title: "First item", state: "open" }, "seed");
  const log = openConfigLog(await readConfig(home));
  try {
    for (const object of objects) {
      const run = await log.startRun("demo-flow", object);
      await log.append(run.runId, 0, [
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "ask",
            prompt: "Approve?",
            choices: ["yes"],
            waitKind: "step",
            effectId: null,
          },
          cause: "test",
        },
      ]);
    }
  } finally {
    await log.close();
  }
  return home;
}

describe("operad pending shows the object's title", () => {
  test("a line with the title, the rest unchanged, and the row in --json", async () => {
    const home = await waitingHome(["item:one"]);
    const out = capture();
    expect(await main(["pending"], { home, io: out.io })).toBe(0);
    const lines = out.text().split("\n");
    expect(lines[0]).toMatch(/^\S+  demo-flow  ask$/);
    expect(lines[1]).toBe("  First item");
    expect(lines[2]).toBe("  waiting: Approve?");
    expect(lines[3]).toBe("  choices: yes");

    const json = capture();
    expect(await main(["pending", "--json"], { home, io: json.io })).toBe(0);
    const items = JSON.parse(json.text()) as { row?: { title: string; waiting: boolean } }[];
    expect(items[0]?.row).toMatchObject({ title: "First item", waiting: true });
  });

  test("an object that is gone shows its error row's title (the id) and still lists", async () => {
    const home = await waitingHome(["item:gone"]);
    const out = capture();
    expect(await main(["pending"], { home, io: out.io })).toBe(0);
    expect(out.text()).toContain("  gone\n");
    expect(out.text()).toContain("  waiting: Approve?");
  });
});
