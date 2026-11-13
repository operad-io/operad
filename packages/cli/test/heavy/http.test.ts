import { afterAll, describe, expect, test } from "bun:test";
import { testEnv } from "../env.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPluginStore, readHttpToken } from "@operad-io/engine";
import { main } from "../../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../../../engine/test/fixtures/plugins/http.ts", import.meta.url),
);
const scopedPluginPath = fileURLToPath(
  new URL("../fixtures/scoped-plugin.ts", import.meta.url),
);

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port;
  await server.stop(true);
  return port;
}

interface Home {
  readonly root: string;
  readonly home: string;
}

async function makeHome(
  listen: readonly string[] = ["127.0.0.1"],
): Promise<Home & { readonly port: number }> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      http: { enabled: true, port, listen },
    }),
  );
  return { root, home, port };
}

function env(home: string): Record<string, string> {
  return {
    ...testEnv(),
    OPERAD_HOME: home,
    OPERAD_SERVE_INTERVAL_MS: "60",
  };
}

async function waitForOutput(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  needle: string,
  timeoutMs = 10_000,
): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);
  try {
    while (!text.includes(needle)) {
      const read = await reader.read();
      if (read.done) break;
      text += decoder.decode(read.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  if (!text.includes(needle)) {
    throw new Error(`the server never printed "${needle}"; saw: ${text}`);
  }
  return text;
}

async function stopChild(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
): Promise<void> {
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.exited,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5_000),
    ),
  ]);
  if (exited === "timeout") child.kill("SIGKILL");
}

describe("operad serve http", () => {
  test("starts with http.enabled, logs one address, and checks the token", async () => {
    const { home, port } = await makeHome();
    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: env(home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const output = await waitForOutput(child, `http http://127.0.0.1:${port}`);
      expect(output).toContain(`http http://127.0.0.1:${port}`);

      const token = await readHttpToken(home);
      expect(token).toBeDefined();
      if (token === undefined) return;

      const missing = await fetch(`http://127.0.0.1:${port}/v1/types`);
      expect(missing.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${port}/v1/types`, {
        headers: { authorization: `Bearer ${token.token}` },
      });
      expect(ok.status).toBe(200);

      const rotate = Bun.spawnSync({
        cmd: [process.execPath, CLI_ENTRY, "http", "token", "rotate"],
        cwd: home,
        env: env(home),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(rotate.exitCode).toBe(0);
      expect(rotate.stdout.toString()).not.toContain(token.token);

      const old = await fetch(`http://127.0.0.1:${port}/v1/types`, {
        headers: { authorization: `Bearer ${token.token}` },
      });
      expect(old.status).toBe(401);

      const rotated = await readHttpToken(home);
      expect(rotated).toBeDefined();
      if (rotated === undefined) return;
      expect(rotated.token).not.toBe(token.token);
      const next = await fetch(`http://127.0.0.1:${port}/v1/types`, {
        headers: { authorization: `Bearer ${rotated.token}` },
      });
      expect(next.status).toBe(200);
    } finally {
      await stopChild(child);
    }
  });

  test("serve resolves ids from no directory: a bare id is not scoped to where serve started", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const repoA = join(root, "repo-a");
    mkdirSync(home, { recursive: true });
    mkdirSync(repoA, { recursive: true });
    const port = await freePort();
    const storePath = join(root, "store");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [scopedPluginPath],
        store: { backend: "sqlite", path: join(storePath, "log.sqlite") },
        http: { enabled: true, port, listen: ["127.0.0.1"] },
      }),
    );
    // The task lives in the other namespace; inside repo-a the plugin would
    // scope its bare id to a/T-0017-x, which does not exist.
    const store = openPluginStore({ backend: "sqlite", root: storePath });
    await store.put("task", "b/T-0017-x", { title: "B" }, "seed");

    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: repoA,
      env: env(home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForOutput(child, `http http://127.0.0.1:${port}`);
      const token = await readHttpToken(home);
      expect(token).toBeDefined();
      if (token === undefined) return;
      for (const id of ["T-0017-x", "task:T-0017-x", "b/T-0017-x"]) {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/objects/${encodeURIComponent(id)}`,
          { headers: { authorization: `Bearer ${token.token}` } },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { readonly id: string };
        expect(body.id).toBe("b/T-0017-x");
      }
    } finally {
      await stopChild(child);
    }
  });

  test("refuses a wildcard at start and names the entry", async () => {
    const { home } = await makeHome(["0.0.0.0"]);
    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: env(home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(`${out}${err}`).toContain("0.0.0.0");
      expect(`${out}${err}`).toContain("wildcard");
      expect(existsSync(join(home, "secrets", "http.json"))).toBe(false);
    } finally {
      await stopChild(child);
    }
  });

  test("no other command opens the port or creates the token", async () => {
    const { home } = await makeHome();
    const io = {
      write: () => undefined,
      error: () => undefined,
    };
    expect(await main(["list", "item"], { home, io })).toBe(0);
    expect(existsSync(join(home, "secrets", "http.json"))).toBe(false);
  });
});
