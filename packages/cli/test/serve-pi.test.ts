// A real `operad serve` process on a home that holds an older pi of operad's own
// (ADR 0023 D9).

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitUntil } from "@operad-io/engine/testing";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { PI_CODING_AGENT_PACKAGE, PI_CODING_AGENT_VERSION } from "../src/defaults.ts";
import { testEnv } from "./env.ts";

afterAll(cleanupTempRoots);

const SERVE = fileURLToPath(new URL("./fixtures/serve-pi-install.ts", import.meta.url));

const started: Bun.Subprocess[] = [];

// Here and not in the tests, so a test that times out leaves no serve running.
afterEach(async () => {
  for (const serve of started.splice(0)) {
    serve.kill("SIGKILL");
    await serve.exited;
  }
});

/** A home with pi on and operad's copy at 1.6.0. */
async function olderPiHome(): Promise<{ readonly home: string; readonly root: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  const project = join(home, "plugins");
  const dir = join(project, "node_modules", PI_CODING_AGENT_PACKAGE);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: PI_CODING_AGENT_PACKAGE, version: "1.6.0", exports: { ".": "./dist/index.js" } }),
  );
  writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "operad-plugins", private: true, dependencies: { [PI_CODING_AGENT_PACKAGE]: "1.6.0" } }),
  );
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: { pi: { module: "@operad-io/harness-pi", enabled: true } },
      http: { enabled: false },
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return { home, root };
}

/** Starts serve with an empty directory as PATH, so there is no `pi` command. */
function startServe(home: string, root: string, outcome: "ok" | "fail" | "hang") {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const serve = Bun.spawn({
    cmd: [process.execPath, SERVE, outcome],
    // Supervised, so a reload ends the process with its code and starts no other.
    env: testEnv({ PATH: bin, HOME: root, OPERAD_HOME: home, [SUPERVISED_ENV]: "1" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  started.push(serve);
  return serve;
}

describe("serve on a home with operad's pi at an older pin", () => {
  test("moves it once it is serving, and reloads", async () => {
    const { home, root } = await olderPiHome();
    const serve = startServe(home, root, "ok");
    const [out, code] = await Promise.all([new Response(serve.stdout).text(), serve.exited]);
    // 75 is the exit of a serve that stopped only to load new code.
    expect(code).toBe(75);
    expect(out).toContain("serving ");
    expect(out.indexOf("reloading: installed pi")).toBeGreaterThan(out.indexOf("serving "));
    const project = JSON.parse(readFileSync(join(home, "plugins", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(project.dependencies[PI_CODING_AGENT_PACKAGE]).toBe(PI_CODING_AGENT_VERSION);
  });

  test("a failed move is logged, and serve goes on with the copy it has", async () => {
    const { home, root } = await olderPiHome();
    const serve = startServe(home, root, "fail");
    const log = join(root, "store", "logs", "pi", "install.log");
    await waitUntil(() => existsSync(log) && readFileSync(log, "utf8").endsWith("\n"), 20_000);
    const text = readFileSync(log, "utf8");
    expect(text).toStartWith(`not moved to ${PI_CODING_AGENT_VERSION}: `);
    expect(text).toContain("could not be downloaded");
    serve.kill("SIGTERM");
    const [out, code] = await Promise.all([new Response(serve.stdout).text(), serve.exited]);
    expect(code).toBe(0);
    expect(out).not.toContain("reloading");
  });

  test("a stop of serve ends a move under way", async () => {
    const { home, root } = await olderPiHome();
    const serve = startServe(home, root, "hang");
    const reader = serve.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    /** Reads until the output holds `text`, or to its end without one. */
    const read = async (text?: string): Promise<void> => {
      while (text === undefined || !out.includes(text)) {
        const chunk = await reader.read();
        if (chunk.done) return;
        out += decoder.decode(chunk.value, { stream: true });
      }
    };
    await read("download started");
    expect(out).toContain("download started");
    serve.kill("SIGTERM");
    await read();
    expect(await serve.exited).toBe(0);
    expect(out).toContain("download aborted");
    expect(out).not.toContain("reloading");
    // A stop is no failure of the move.
    expect(existsSync(join(root, "store", "logs", "pi", "install.log"))).toBe(false);
  });
});
