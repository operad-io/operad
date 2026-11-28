// A secret answer over HTTP reaches the step (ADR 0008 D8). `serve` takes the
// answer; the step waits in the run's own process.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openConfigLog, readConfig, readHttpToken, type PendingItem } from "@operad-io/engine";
import { waitForChange } from "@operad-io/engine/platform";
import { freePort, makeHome } from "@operad-io/engine/testing";
import { cleanupTempRoots } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const CLI_ENTRY = path("../../bin/operad.ts");
const engine = path("../../../engine/src/index.ts");
const SECRET = "sk-made-up-0822-not-a-key";

const FLOW = `import { defineFlow } from ${JSON.stringify(engine)};
export default defineFlow({
  name: "key",
  entry: "one",
  steps: [
    { id: "one", kind: "plugin", params: { use: "secret-steps/key", params: {} }, replay: "unsafe", next: { done: "end_done", failed: "end_failed", interrupted: "end_failed" } },
    { id: "end_done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "end_failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});
`;

/** Starts a real `serve` on the home and gives an HTTP client of it. */
async function serving(home: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: { ...testEnv(), OPERAD_HOME: home, OPERAD_SERVE_INTERVAL_MS: "100" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let base: string | undefined;
  while (base === undefined || !seen.includes("serving ")) {
    const read = await reader.read();
    if (read.done) throw new Error(`serve ended before it listened: ${seen}`);
    seen += decoder.decode(read.value, { stream: true });
    base = /^http (\S+)\n/m.exec(seen)?.[1];
  }
  reader.releaseLock();
  const token = (await readHttpToken(home))?.token ?? "";
  const request = async (method: string, at: string, body?: unknown) => {
    const response = await fetch(`${base}${at}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-operad-client": "desktop" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    await child.exited;
  };
  return { request, stop };
}

/** Looks again each time the log changes, until `read` gives a value. */
async function fromLog<T>(
  home: string,
  read: (log: ReturnType<typeof openConfigLog>) => Promise<T | undefined>,
): Promise<T> {
  const config = await readConfig(home);
  for (;;) {
    const log = openConfigLog(config, { follow: false });
    try {
      const found = await read(log);
      if (found !== undefined) return found;
    } finally {
      await log.close();
    }
    await waitForChange(dirname(config.store.path), basename(config.store.path), 100);
  }
}

/** The pending question of the run, once it has opened `count` of them. */
async function question(
  home: string,
  request: Awaited<ReturnType<typeof serving>>["request"],
  runId: string,
  count: number,
): Promise<PendingItem> {
  await fromLog(home, async (log) => {
    let opened = 0;
    for await (const fact of log.read(runId)) {
      if (fact.kind === "ask_opened") opened += 1;
      if (fact.kind === "step_result") throw new Error(`the step ended: ${JSON.stringify(fact.payload)}`);
    }
    return opened >= count ? true : undefined;
  });
  const pending = await request("GET", "/v1/pending");
  const item = (pending.body as unknown as PendingItem[]).find((found) => found.runId === runId);
  if (item === undefined) throw new Error(`no pending question: ${JSON.stringify(pending.body)}`);
  return item;
}

/** The run's step result and everything recorded about it, once it has ended. */
async function ended(home: string, runId: string): Promise<{ result: unknown }> {
  return fromLog(home, async (log) => {
    const run = await log.run(runId);
    if (run === undefined || run.active) return undefined;
    let result: unknown;
    for await (const fact of log.read(runId)) {
      if (fact.kind === "step_result") result = fact.payload;
    }
    return { result };
  });
}

/** Every byte of the log database: facts and inputs alike. */
function stored(storeRoot: string): string {
  return readdirSync(storeRoot)
    .filter((name) => name.startsWith("log.sqlite"))
    .map((name) => readFileSync(join(storeRoot, name)).toString("latin1"))
    .join("");
}

function handedOver(home: string): string[] {
  const directory = join(home, "secrets", "answers");
  return existsSync(directory) ? readdirSync(directory) : [];
}

async function httpHome(plugins: unknown[]) {
  return makeHome({
    plugins,
    extra: { http: { enabled: true, port: await freePort(), listen: ["127.0.0.1"] } },
  });
}

test("a secret answer over HTTP reaches the step, is never recorded, and a second is refused", async () => {
  const { home, storeRoot } = await httpHome([path("../fixtures/secret-ask-plugin.ts")]);
  mkdirSync(join(home, "flows"), { recursive: true });
  writeFileSync(join(home, "flows", "key.flow.ts"), FLOW);
  const serve = await serving(home);
  try {
    const started = await serve.request("POST", "/v1/flows/start", { flow: "home:key" });
    const runId = String(started.body.runId);
    const item = await question(home, serve.request, runId, 1);
    const answer = { runId, waitId: item.waitId, answers: [{ id: "value", text: SECRET }] };
    expect((await serve.request("POST", "/v1/answer", answer)).status).toBe(200);
    const again = await serve.request("POST", "/v1/answer", {
      ...answer,
      answers: [{ id: "value", text: "another" }],
    });
    expect(again.status).not.toBe(200);

    const run = await ended(home, runId);
    expect(run.result).toMatchObject({ result: "done" });
    expect(JSON.parse(readFileSync(join(home, "received.json"), "utf8"))).toEqual({ text: SECRET });
    expect(stored(storeRoot)).not.toContain(SECRET);
    expect(handedOver(home)).toEqual([]);
  } finally {
    await serve.stop();
  }
}, 30_000);

test("the pi login over HTTP saves the key and ends logged in", async () => {
  const root = await httpHome([]);
  const { home } = root;
  const authPath = join(home, "pi-auth.json");
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      ...config,
      plugins: {
        chat: path("../../../chat/src/index.ts"),
        bot: path("../../../bot/src/index.ts"),
        pi: {
          module: path("../fixtures/fake-pi-login-plugin.ts"),
          settings: {
            authPath,
            modelsPath: join(root.root, "models.json"),
            models: ["anthropic/m"],
            model: "anthropic/m",
          },
        },
      },
    }),
  );
  const serve = await serving(home);
  try {
    const acted = await serve.request("POST", "/v1/act", { action: "bot:login", id: "default" });
    expect(acted.status).toBe(200);
    const runId = await fromLog(home, async (log) =>
      (await log.runs({ object: "bot:default" })).find((run) => run.flow === "bot:login")?.runId,
    );
    const answer = (body: Record<string, unknown>) => serve.request("POST", "/v1/answer", { runId, ...body });

    const provider = await question(home, serve.request, runId, 1);
    expect((await answer({ waitId: provider.waitId, choice: "anthropic" })).status).toBe(200);
    const key = await question(home, serve.request, runId, 2);
    expect((await answer({ waitId: key.waitId, answers: [{ id: "value", text: SECRET }] })).status).toBe(200);
    const model = await question(home, serve.request, runId, 3);
    expect((await answer({ waitId: model.waitId, choice: "anthropic/m" })).status).toBe(200);

    const run = await ended(home, runId);
    expect(run.result).toMatchObject({ result: "done", data: { agent: "pi", model: "anthropic/m" } });
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: SECRET },
    });
    expect(stored(root.storeRoot)).not.toContain(SECRET);
    expect(handedOver(home)).toEqual([]);
  } finally {
    await serve.stop();
  }
}, 30_000);
