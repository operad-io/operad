// A real `operad serve` process asked for terminals while it installs their
// package (ADR 0029 D4).

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginProjectPath, readHttpToken } from "@operad-io/engine";
import { waitUntil } from "@operad-io/engine/testing";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { testEnv } from "./env.ts";
import { installTerminalElsewhere } from "./fixtures/install-terminal.ts";

afterAll(cleanupTempRoots);

const SERVE = fileURLToPath(new URL("./fixtures/serve-terminal-install.ts", import.meta.url));
const INSTALLER = fileURLToPath(new URL("./fixtures/installs-terminal-plugin.ts", import.meta.url));

const started: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const serve of started.splice(0)) {
    serve.kill("SIGKILL");
    await serve.exited;
  }
});

/** A `serve` on a new home with terminals on and without their package, once it answers HTTP. */
async function serveWithoutPackage(root: string, others: Readonly<Record<string, unknown>> = {}) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: { terminal: { module: "@operad-io/terminal", enabled: true }, ...others },
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
  const read = async (needle: RegExp): Promise<void> => {
    while (!needle.test(out)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`serve ended without ${String(needle)}: ${out}`);
      out += decoder.decode(chunk.value, { stream: true });
    }
  };
  await read(/^http \S+\n/m);
  const url = /^http (\S+)$/m.exec(out)?.[1] ?? "";
  const token = (await readHttpToken(home))?.token ?? "";
  const ask = async () =>
    (await fetch(`${url}/v1/terminal`, { headers: { authorization: `Bearer ${token}` } })).status;
  return { root, home, read, ask };
}

describe("serve while it installs the terminal package", () => {
  test("says terminals are starting, and that there are none once the install has failed", async () => {
    const root = await tempRoot();
    const { home, read, ask } = await serveWithoutPackage(root);
    await read(/download started\n/);
    expect(await ask()).toBe(503);
    writeFileSync(join(home, "fail-download"), "");
    // The failure is logged once serve is done with the install.
    const log = join(root, "store", "logs", "terminal", "install.log");
    await waitUntil(() => existsSync(log) && readFileSync(log, "utf8").endsWith("\n"), 20_000);
    expect(await ask()).toBe(404);
  });

  test("reloads when another process installed the package meanwhile", async () => {
    const root = await tempRoot();
    const project = pluginProjectPath(join(root, "home"));
    mkdirSync(project, { recursive: true });
    // This process is the other install: serve waits for it to end. Without a
    // start time the record holds while this process lives; `bun test` reads
    // that time in another time zone than the child would.
    const lock = join(project, ".install.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: null, nonce: "other-install" }));
    const { home, read, ask } = await serveWithoutPackage(root);
    expect(await ask()).toBe(503);
    installTerminalElsewhere(home);
    rmSync(lock);
    await read(/^reloading: installed terminal\n/m);
  });

  test("reloads when the package arrived while the plugins were loading", async () => {
    const root = await tempRoot();
    // Loaded after terminals, so their stand-in is what serve runs.
    const { read } = await serveWithoutPackage(root, { installer: { module: INSTALLER, enabled: true } });
    await read(/^reloading: installed terminal\n/m);
  });
});
