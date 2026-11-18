import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const cronPluginPath = fileURLToPath(
  new URL("../../source-cron/src/index.ts", import.meta.url),
);
const flowPluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/rules.ts", import.meta.url),
);

function capture(): { io: CliIo; text(): string; errors(): string } {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

async function makeHome(): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [flowPluginPath, cronPluginPath],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return home;
}

describe("operad scheduled", () => {
  test("adds a flow, lists it, and refuses an unknown flow", async () => {
    const home = await makeHome();
    const added = capture();
    expect(
      await main(
        [
          "scheduled",
          "add",
          "--flow",
          "plugin-one",
          "--schedule",
          "0 8 * * *",
          "--params",
          '{"from":"cli"}',
        ],
        { home, io: added.io },
      ),
    ).toBe(0);
    expect(added.text()).toContain("scheduled plugin-one");

    const listed = capture();
    expect(await main(["scheduled", "list", "--json"], { home, io: listed.io })).toBe(0);
    const entries = JSON.parse(listed.text()) as {
      flow: string;
      schedule: string;
      params: unknown;
      nextRun: string | null;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      flow: "plugin-one",
      schedule: "0 8 * * *",
      params: { from: "cli" },
    });
    expect(entries[0]?.nextRun).not.toBeNull();

    const refused = capture();
    expect(
      await main(
        ["scheduled", "add", "--flow", "missing", "--schedule", "0 8 * * *"],
        { home, io: refused.io },
      ),
    ).toBe(1);
    expect(refused.errors()).toContain('unknown flow "missing"');
  });

  test("an empty --params clears a flow's parameters", async () => {
    const home = await makeHome();
    await main(
      [
        "scheduled",
        "add",
        "--flow",
        "plugin-one",
        "--schedule",
        "0 8 * * *",
        "--params",
        '{"from":"cli"}',
      ],
      { home, io: capture().io },
    );
    const before = capture();
    expect(await main(["scheduled", "list", "--json"], { home, io: before.io })).toBe(0);
    const [entry] = JSON.parse(before.text()) as { readonly id: string }[];
    if (entry === undefined) throw new Error("no scheduled flow");
    expect(
      await main(["scheduled", "edit", entry.id, "--params", ""], {
        home,
        io: capture().io,
      }),
    ).toBe(0);
    const after = capture();
    expect(await main(["scheduled", "list", "--json"], { home, io: after.io })).toBe(0);
    const [cleared] = JSON.parse(after.text()) as { readonly params?: unknown }[];
    expect(cleared?.params).toBeUndefined();
  });
});
