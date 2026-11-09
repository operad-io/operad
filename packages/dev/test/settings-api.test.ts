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
      store: { backend: "jsonl", path: join(root, "store") },
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
    }[];
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get("dev.dev.concurrency")).toMatchObject({ editable: true, confirm: false });
    expect(byName.get("dev.dev.reviewer.use")?.description).toContain("reviews a task");
    expect(byName.get("dev.dev.reviewer.timeoutSecs")?.editable).toBe(true);
    expect(byName.get("dev.dev.gate.commandTimeoutSecs")?.editable).toBe(true);
    expect(byName.get("dev.dev.gate.commands")?.editable).toBe(true);
    expect(byName.get("dev.dev.reviewer.fixLevel")).toMatchObject({ editable: true, confirm: true });
    expect(byName.get("dev.review.default.fixLevel")).toMatchObject({ editable: true, confirm: true });
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
});
