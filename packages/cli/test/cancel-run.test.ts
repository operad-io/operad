import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  Runner,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  readState,
  storeRootOf,
} from "@operad-io/engine";
import { main } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const pluginPath = fileURLToPath(new URL("./fixtures/cancel-plugin.ts", import.meta.url));

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** A home whose job waits on a run that is paused for a person. */
async function makeWaiting(http: boolean): Promise<{
  readonly home: string;
  readonly runId: string;
  readonly port: number;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const port = http ? await freePort() : 0;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
      ...(http ? { http: { enabled: true, port, listen: ["127.0.0.1"] } } : {}),
    }),
  );
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store = new FilePluginStore({ root: join(storeRoot, "plugins") });
  const registry = await loadPluginRegistry({ home, store });
  const found = registry.flow("hold");
  if (found === undefined) throw new Error("missing hold flow");
  const log = openConfigLog(config);
  const info = await log.startRun("hold", "job:1");
  await new Runner({
    log,
    flow: found.flow,
    runId: info.runId,
    registry,
    lockRoot: storeRoot,
  }).run();
  await log.close();
  store.put("job", "1", { run: info.runId }, "seed");
  return { home, runId: info.runId, port };
}

async function endedState(home: string, runId: string): Promise<string> {
  const log = openConfigLog(await readConfig(home));
  try {
    return (await readState(log, runId)).status;
  } finally {
    await log.close();
  }
}

describe("cancelling an object ends the run that waits on it", () => {
  test("through the command line", async () => {
    const { home, runId } = await makeWaiting(false);
    expect(await endedState(home, runId)).toBe("waiting_person");
    const lines: string[] = [];
    const io = {
      write: (text: string) => void lines.push(text),
      error: (text: string) => void lines.push(text),
    };
    expect(await main(["canceltest:stop", "job:1"], { home, io })).toBe(0);
    expect(await endedState(home, runId)).toBe("ended");
  });

  test("through serve, as the terminal client and the web act", async () => {
    const { home, runId, port } = await makeWaiting(true);
    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: {
        ...(process.env as Record<string, string>),
        OPERAD_HOME: home,
        OPERAD_SERVE_INTERVAL_MS: "60",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes(`http http://127.0.0.1:${port}`)) {
        const read = await reader.read();
        if (read.done) throw new Error(`serve ended: ${seen}`);
        seen += decoder.decode(read.value);
      }
      reader.releaseLock();
      const token = await readHttpToken(home);
      if (token === undefined) throw new Error("no token");
      const response = await fetch(`http://127.0.0.1:${port}/v1/act`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "canceltest:stop", id: "job:1", confirmed: true }),
      });
      expect(response.status).toBe(200);
      expect(await endedState(home, runId)).toBe("ended");
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  });
});
