import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, makeGitRepository, runInProcess, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

const PLUGIN = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const POOL = fileURLToPath(new URL("../../../pool/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../../shell/src/index.ts", import.meta.url));

const run = runInProcess;

async function setup() {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: { dev: PLUGIN, pool: POOL, shell: SHELL },
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  const repository = await makeGitRepository(root);
  const added = await run(home, repository, ["repo", "add", "."]);
  expect(added.code).toBe(0);
  const name = repository.split("/").pop() ?? "";
  return { home, repository, name };
}

describe("dev settings through operad settings", () => {
  test("lists the home's and the repository's settings with descriptions", async () => {
    const { home, repository, name } = await setup();
    const global = await run(home, repository, ["settings"]);
    expect(global.code).toBe(0);
    expect(global.out).toContain("global  dev.checks  2  default 2  editable  How many checks");

    const project = await run(home, repository, ["settings", "--repo", name, "--json"]);
    expect(project.code).toBe(0);
    const items = JSON.parse(project.out) as {
      name: string;
      editable: boolean;
      confirm: boolean;
      description?: string;
      default?: unknown;
    }[];
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get("dev.concurrency")).toMatchObject({ editable: true, confirm: false });
    expect(byName.get("dev.reviewer.use")?.description).toContain("reviews a task");
    expect(byName.get("dev.reviewer.timeoutSecs")?.editable).toBe(true);
    expect(byName.get("dev.gate.commandTimeoutSecs")?.editable).toBe(true);
    expect(byName.get("dev.gate.stallSecs")?.editable).toBe(true);
    expect(byName.get("dev.gate.commands")?.editable).toBe(true);
    expect(byName.get("dev.reviewer.fixLevel")).toMatchObject({ editable: true, confirm: true });
    expect(byName.get("dev.review.default.fixLevel")).toMatchObject({ editable: true, confirm: true });
    expect(byName.get("dev.autoDefault")).toMatchObject({ editable: true, confirm: true, default: "off" });
    expect(byName.get("dev.concurrency")?.default).toBeUndefined();
    expect(project.out).not.toContain("dev.dev.");
    for (const item of items) {
      expect(item.description).toBeTruthy();
      // dev.flowList is the one read-only setting: the flows a client reads.
      expect(item.editable).toBe(item.name !== "dev.flowList");
    }
    const old = await run(home, repository, [
      "settings", "set", "dev.dev.concurrency", "2", "--repo", name,
    ]);
    expect(old.code).toBe(1);
    expect(old.err).toContain('no setting "dev.dev.concurrency"');
  });

  test("an invalid review.json level is refused and nothing is written; a valid one needs --yes", async () => {
    const { home, repository, name } = await setup();
    const bad = await run(home, repository, [
      "settings", "set", "dev.review.default.fixLevel", "urgent", "--repo", name, "--yes",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("fixLevel");
    const file = join(repository, ".operad", "review.json");
    expect(() => readFileSync(file, "utf8")).toThrow();

    const unconfirmed = await run(home, repository, [
      "settings", "set", "dev.review.default.fixLevel", "minor", "--repo", name,
    ]);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("--yes");

    const good = await run(home, repository, [
      "settings", "set", "dev.review.default.fixLevel", "minor", "--repo", name, "--yes",
    ]);
    expect(good.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ default: { fixLevel: "minor" } });
  });

  test("a command list dev would refuse is refused and nothing is written", async () => {
    const { home, repository, name } = await setup();
    const file = join(repository, ".operad", "dev.json");
    const before = readFileSync(file, "utf8");
    for (const bad of ["[1]", '[""]']) {
      const result = await run(home, repository, [
        "settings", "set", "dev.gate.commands", bad, "--repo", name,
      ]);
      expect(result.code).toBe(2);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    const good = await run(home, repository, [
      "settings", "set", "dev.gate.commands", '["bun test"]', "--repo", name,
    ]);
    expect(good.code).toBe(0);
  });

  test("a new plan starts at the auto level the repository sets", async () => {
    const { home, repository, name } = await setup();
    const set = await run(home, repository, [
      "settings", "set", "dev.autoDefault", "run", "--repo", name, "--yes",
    ]);
    expect(set.code).toBe(0);
    const bad = await run(home, repository, [
      "settings", "set", "dev.autoDefault", "always", "--repo", name, "--yes",
    ]);
    expect(bad.code).toBe(2);
    const plan = await run(home, repository, ["plan", "add", "--slug", "alpha", "--title", "Alpha"]);
    expect(plan.code).toBe(0);
    const listed = await run(home, repository, ["list", "plan"]);
    const line = listed.out.split("\n")[0] ?? "";
    expect(line).toContain("  run  ");
    expect(line.match(/run/g)).toHaveLength(1);
    expect(line).not.toContain(" · run · ");
  });
});
