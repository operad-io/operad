import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqlitePluginStore,
  createViews,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  startHttpServer,
  storeRootOf,
  type HttpServerHandle,
  type TriggerRule,
} from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { scheduledId } from "../src/index.ts";

afterAll(cleanupTempRoots);

const CRON = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../shell/src/index.ts", import.meta.url));

const rule: TriggerRule = {
  source: "cron",
  type: "tick",
  start: { flow: "shell:command", params: { command: "echo hi" } },
  object: "routine:one",
  mode: "auto",
  schedule: "0 3 * * *",
};

test("a client offers to-flow without an object, and the routine then runs the file", async () => {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ plugins: [SHELL, CRON], store: { backend: "sqlite", path: join(root, "store", "log.sqlite") } }),
  );
  writeFileSync(join(home, "triggers.json"), JSON.stringify([rule]));
  const config = await readConfig(home);
  const store = new SqlitePluginStore({ root: storeRootOf(config) });
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({ home, store });
  const views = createViews({ registry, store, log, home, onLog: () => undefined });
  let server: HttpServerHandle | undefined;
  try {
    server = await startHttpServer({
      home,
      config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
      views,
      log,
      registry,
      onLog: () => undefined,
    });
    const token = await readHttpToken(home);
    const base = server.urls[0];
    if (token === undefined || base === undefined) throw new Error("the server did not start");
    const act = (args: unknown): Promise<Response> =>
      fetch(`${base}/v1/act`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "cron:to-flow", args }),
      });

    const done = await act({ routine: scheduledId(rule), name: "mine" });
    expect(done.status).toBe(200);
    const value = ((await done.json()) as { value: string }).value;
    expect(value).toContain("home:mine");
    expect(readFileSync(join(home, "flows", "mine.flow.ts"), "utf8")).toContain('"echo hi"');
    expect(JSON.parse(readFileSync(join(home, "triggers.json"), "utf8"))[0].start).toEqual({ flow: "home:mine" });

    const again = await act({ routine: scheduledId(rule), name: "mine" });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const unknown = await act({ routine: "nope" });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(home, "flows", "routine-nope.flow.ts"))).toBe(false);
  } finally {
    await server?.stop();
    views.close();
    await log.close();
  }
});
