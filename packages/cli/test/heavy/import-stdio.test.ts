import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/import-main-without-stdio.ts", import.meta.url),
);
const RUN_FIXTURE = fileURLToPath(
  new URL("../fixtures/run-main-without-stdio.ts", import.meta.url),
);
const PLUGIN = fileURLToPath(
  new URL("../../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

afterAll(cleanupTempRoots);

let home = "";
beforeAll(async () => {
  const root = await tempRoot();
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [PLUGIN],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
});

interface GuardedResult {
  readonly code?: number | undefined;
  readonly out: string;
  readonly err: string;
  readonly touched?: string | undefined;
  readonly failure?: string | undefined;
}

async function runGuarded(
  argv: readonly string[],
  tty: boolean,
): Promise<GuardedResult> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      RUN_FIXTURE,
      home,
      tty ? "tty" : "plain",
      ...argv,
    ],
    env: testEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, err).toBe(0);
  const line = out.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as GuardedResult;
}

describe("the CLI's module", () => {
  test("does not touch process.stdout or process.stderr when it is imported", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, FIXTURE],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${out}${err}`).toBe(0);
    expect(out).toBe("imported\n");
    expect(err).toBe("");
  });
});

describe("the CLI's main with injected output", () => {
  test("list takes the terminal from the descriptors, not process.stdout", async () => {
    const result = await runGuarded(["list", "item"], false);
    expect(result.failure).toBeUndefined();
    expect(result.touched).toBeUndefined();
    expect(result.code).toBe(0);
    expect(`${result.out}${result.err}`).not.toContain("read process.");
  });

  test("pair takes the terminal from the descriptor, not process.stdout", async () => {
    const result = await runGuarded(["pair"], false);
    expect(result.failure).toBeUndefined();
    expect(result.touched).toBeUndefined();
    expect(result.code).toBe(2);
    expect(`${result.out}${result.err}`).not.toContain("read process.");
  });

  test("show takes its width without reading process.stdout when it is not a terminal", async () => {
    const result = await runGuarded(["show", "item:one"], true);
    expect(result.failure).toBeUndefined();
    expect(result.touched).toBeUndefined();
    expect(result.code).toBe(1);
    expect(`${result.out}${result.err}`).not.toContain("read process.");
  });
});
