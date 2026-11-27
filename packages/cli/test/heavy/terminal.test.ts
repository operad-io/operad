/** The `terminal` plugin behind a real `operad serve` process. */

import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHttpToken } from "@operad-io/engine";
import { cleanupTempRoots, freePort, makeHome } from "@operad-io/engine/testing";
import { main } from "../../src/main.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const REPOSITORIES = fileURLToPath(new URL("../fixtures/repository-plugin.ts", import.meta.url));

/** Settles once the child's output holds `needle`; fails when the output ends first. */
async function printed(child: Bun.Subprocess<"ignore", "pipe", "pipe">, needle: string): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const read = await reader.read();
    if (read.done) throw new Error(`serve never printed "${needle}"; saw: ${text}`);
    text += decoder.decode(read.value, { stream: true });
  }
  reader.releaseLock();
}

test("a home that enables terminal serves it, and stopping serve ends its terminals", async () => {
  const port = await freePort();
  const { root, home } = await makeHome({
    plugins: { "repository-fixture": { module: REPOSITORIES } },
    extra: { http: { enabled: true, port, listen: ["127.0.0.1"] } },
  });
  const quiet = { write: () => undefined, error: () => undefined };
  expect(await main(["plugin", "enable", "terminal"], { home, io: quiet })).toBe(0);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    plugins: Record<string, unknown>;
  };
  expect(config.plugins.terminal).toMatchObject({ module: "@operad-io/terminal", enabled: true });

  const repository = join(realpathSync(root), "repository");
  mkdirSync(repository);
  const fifo = join(root, "alive");
  execFileSync("mkfifo", [fifo]);
  const alive = createReadStream(fifo, { encoding: "utf8" });
  const up = new Promise<void>((resolve) => alive.once("data", () => resolve()));
  const gone = new Promise<void>((resolve) => alive.once("end", () => resolve()));

  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: {
      ...testEnv(),
      OPERAD_HOME: home,
      OPERAD_SERVE_INTERVAL_MS: "60",
      OPERAD_TEST_REPOSITORY: repository,
      SHELL: "/bin/bash",
      HOME: root,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Printed once the plugins that serve starts are running.
    await printed(child, `serving ${home}`);
    const token = (await readHttpToken(home))?.token ?? "";
    const started = await fetch(`http://127.0.0.1:${port}/v1/terminal`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        folder: repository,
        command: `trap '' TERM HUP; exec 3>'${fifo}'; echo up >&3; sleep 600`,
        cols: 80,
        rows: 24,
      }),
    });
    expect(started.status).toBe(201);
    await up;

    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await gone;
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("serve whose trigger rules cannot be loaded still serves terminals", async () => {
  const port = await freePort();
  const { home } = await makeHome({
    plugins: {},
    extra: { http: { enabled: true, port, listen: ["127.0.0.1"] } },
  });
  const quiet = { write: () => undefined, error: () => undefined };
  expect(await main(["plugin", "enable", "terminal"], { home, io: quiet })).toBe(0);
  writeFileSync(join(home, "triggers.json"), "{");

  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: { ...testEnv(), OPERAD_HOME: home, OPERAD_SERVE_INTERVAL_MS: "60" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await printed(child, `serving ${home}`);
    const token = (await readHttpToken(home))?.token ?? "";
    const listed = await fetch(`http://127.0.0.1:${port}/v1/terminal`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toContain("triggers.json");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});
