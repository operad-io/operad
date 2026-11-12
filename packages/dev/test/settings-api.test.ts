import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, makeGitRepository, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../cli/bin/operad.ts", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const POOL = fileURLToPath(new URL("../../pool/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../shell/src/index.ts", import.meta.url));

async function run(home: string, cwd: string, args: readonly string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd,
    env: { ...process.env, OPERAD_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

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
    expect(byName.get("dev.dev.concurrency")).toMatchObject({ editable: true, confirm: false });
    expect(byName.get("dev.dev.reviewer.use")?.description).toContain("reviews a task");
    expect(byName.get("dev.dev.reviewer.timeoutSecs")?.editable).toBe(true);
    expect(byName.get("dev.dev.gate.commandTimeoutSecs")?.editable).toBe(true);
    expect(byName.get("dev.dev.gate.commands")?.editable).toBe(true);
    expect(byName.get("dev.dev.reviewer.fixLevel")).toMatchObject({ editable: true, confirm: true });
    expect(byName.get("dev.review.default.fixLevel")).toMatchObject({ editable: true, confirm: true });
    expect(byName.get("dev.dev.autoDefault")).toMatchObject({ editable: true, confirm: true, default: "off" });
    expect(byName.get("dev.dev.concurrency")?.default).toBeUndefined();
    for (const item of items) {
      expect(item.description).toBeTruthy();
      expect(item.editable).toBe(true);
    }
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
        "settings", "set", "dev.dev.gate.commands", bad, "--repo", name,
      ]);
      expect(result.code).toBe(2);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    const good = await run(home, repository, [
      "settings", "set", "dev.dev.gate.commands", '["bun test"]', "--repo", name,
    ]);
    expect(good.code).toBe(0);
  });

  test("a new plan starts at the auto level the repository sets", async () => {
    const { home, repository, name } = await setup();
    const set = await run(home, repository, [
      "settings", "set", "dev.dev.autoDefault", "run", "--repo", name, "--yes",
    ]);
    expect(set.code).toBe(0);
    const bad = await run(home, repository, [
      "settings", "set", "dev.dev.autoDefault", "always", "--repo", name, "--yes",
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
