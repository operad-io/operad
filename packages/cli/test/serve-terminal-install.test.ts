// A real `operad serve` process asked for terminals while it installs their
// package (ADR 0029 D4).

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHttpToken } from "@operad-io/engine";
import { waitUntil } from "@operad-io/engine/testing";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { testEnv } from "./env.ts";

afterAll(cleanupTempRoots);

const SERVE = fileURLToPath(new URL("./fixtures/serve-terminal-install.ts", import.meta.url));

const started: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const serve of started.splice(0)) {
    serve.kill("SIGKILL");
    await serve.exited;
  }
});

describe("serve while it installs the terminal package", () => {
  test("says terminals are starting, and that there are none once the install has failed", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { terminal: { module: "@operad-io/terminal", enabled: true } },
        http: { enabled: true, port: 0, listen: ["127.0.0.1"] },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    const serve = Bun.spawn({
      cmd: [process.execPath, SERVE],
      env: testEnv({ HOME: root, OPERAD_HOME: home, [SUPERVISED_ENV]: "1" }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    started.push(serve);
    const reader = serve.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (!out.includes("download started\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`serve ended before the download: ${out}`);
      out += decoder.decode(chunk.value, { stream: true });
    }
    const url = /^http (\S+)$/m.exec(out)?.[1] ?? "";
    const token = (await readHttpToken(home))?.token ?? "";
    const ask = async () =>
      (await fetch(`${url}/v1/terminal`, { headers: { authorization: `Bearer ${token}` } })).status;

    expect(await ask()).toBe(503);
    writeFileSync(join(home, "fail-download"), "");
    // The failure is logged once serve is done with the install.
    const log = join(root, "store", "logs", "terminal", "install.log");
    await waitUntil(() => existsSync(log) && readFileSync(log, "utf8").endsWith("\n"), 20_000);
    expect(await ask()).toBe(404);
  });
});
