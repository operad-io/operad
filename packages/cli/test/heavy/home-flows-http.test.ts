import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openConfigLog, readConfig, readHttpToken, type LoadedFlow } from "@operad-io/engine";
import { waitForChange } from "@operad-io/engine/platform";
import { freePort, makeHome } from "@operad-io/engine/testing";
import { cleanupTempRoots } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const stepsPlugin = fileURLToPath(
  new URL("../../../engine/test/fixtures/plugins/home-steps.ts", import.meta.url),
);
const ownFlowPlugin = fileURLToPath(
  new URL("../../../engine/test/fixtures/plugins/own-flow.ts", import.meta.url),
);
const engine = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));

const FLOW = `import { defineFlow } from ${JSON.stringify(engine)};
export default defineFlow({
  name: "echo",
  entry: "one",
  steps: [
    { id: "one", kind: "plugin", params: { use: "home-steps/echo", params: {} }, replay: "safe", next: { ok: "end_done" } },
    { id: "end_done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});
`;

/** Resolves once the run has ended: the log says so. */
async function waitForEnded(home: string, runId: string): Promise<void> {
  const config = await readConfig(home);
  for (;;) {
    const log = openConfigLog(config, { follow: false });
    try {
      const run = await log.run(runId);
      if (run !== undefined && !run.active) return;
    } finally {
      await log.close();
    }
    await waitForChange(dirname(config.store.path), basename(config.store.path), 100);
  }
}

/** Resolves with the address once the serve prints it. */
async function address(child: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const found = /^http (\S+)\n/m.exec(seen)?.[1];
    if (found !== undefined && seen.includes("serving ")) {
      reader.releaseLock();
      return found;
    }
    const read = await reader.read();
    if (read.done) throw new Error(`serve ended before it listened: ${seen}`);
    seen += decoder.decode(read.value, { stream: true });
  }
}

test("serve lists the flows over HTTP and runs one a client starts to its end", async () => {
  const { home } = await makeHome({
    plugins: [stepsPlugin, ownFlowPlugin],
    extra: { http: { enabled: true, port: await freePort(), listen: ["127.0.0.1"] } },
  });
  mkdirSync(join(home, "flows"), { recursive: true });
  writeFileSync(join(home, "flows", "echo.flow.ts"), FLOW);
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: { ...testEnv({}), OPERAD_HOME: home, OPERAD_SERVE_INTERVAL_MS: "100" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const base = await address(child);
    const token = (await readHttpToken(home))?.token ?? "";
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "x-operad-client": "desktop" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const refusal = (kind: string, message: string) => ({
      error: { kind, message: expect.stringContaining(message) },
    });

    const listed = await request("GET", "/v1/flows");
    expect(listed.status).toBe(200);
    const flows = listed.body.flows as LoadedFlow[];
    expect(flows.map((flow) => [flow.name, flow.plugin])).toEqual([
      ["builtin-touch", "own-flow"],
      ["home:echo", "home"],
    ]);
    expect(flows[1]?.path).toBe(join(home, "flows", "echo.flow.ts"));
    expect((await request("POST", "/v1/flows", {})).status).toBe(405);
    expect((await request("GET", "/v1/flows/start")).status).toBe(405);

    const refused: readonly (readonly [unknown, number, string, string])[] = [
      [[], 400, "args", "the body must be an object"],
      [{}, 400, "args", "the body needs a flow"],
      [{ flow: "home:nope" }, 404, "not-found", 'flow "home:nope" is not loaded'],
      [{ flow: "builtin-touch" }, 422, "refused", "only a flow of the home"],
      [{ flow: "home:echo", params: "word" }, 400, "args", "params must be a JSON object"],
    ];
    for (const [body, status, kind, message] of refused) {
      const answer = await request("POST", "/v1/flows/start", body);
      expect(answer).toMatchObject({ status, body: refusal(kind, message) });
    }

    const started = await request("POST", "/v1/flows/start", {
      flow: "home:echo",
      params: { word: "hello" },
    });
    expect(started).toMatchObject({ status: 200, body: { flow: "home:echo" } });
    const runId = String(started.body.runId);
    await waitForEnded(home, runId);

    const log = openConfigLog(await readConfig(home), { follow: false });
    try {
      const said: string[] = [];
      for await (const fact of log.read(runId)) said.push(JSON.stringify(fact.payload));
      expect(said.join("\n")).toContain('"given":{"word":"hello"}');
      const actors: unknown[] = [];
      for await (const fact of log.readGlobal()) {
        if (fact.kind === "flow_started_by_hand") actors.push(fact.payload);
      }
      expect(actors).toMatchObject([{ runId, actor: { via: "desktop" } }]);
    } finally {
      await log.close();
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});
