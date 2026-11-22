import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  type JsonValue,
  type PluginStepResult,
} from "@operad-io/engine";
import { readKeptWorkers, stopAllKeptWorkers } from "@operad-io/engine/platform";
import { alive } from "@operad-io/engine/testing";
import { createPiHarnessPlugin } from "../../src/index.ts";

const FAKE = fileURLToPath(new URL("../fake-kept-worker.ts", import.meta.url));
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env["FAKE_KEEP_RECORD"];
  delete process.env["FAKE_KEEP_FAIL"];
  delete process.env["FAKE_KEEP_HANG"];
  delete process.env["FAKE_KEEP_HANG_ONCE"];
  delete process.env["FAKE_KEEP_SESSION"];
});

interface Env {
  readonly root: string;
  readonly registry: PluginRegistry;
  readonly record: string;
  readonly clock: { readonly now: number };
}

function setup(extra: Record<string, unknown> = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "k-"));
  roots.push(root);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const record = join(root, "record.jsonl");
  process.env["FAKE_KEEP_RECORD"] = record;
  const plugin = createPiHarnessPlugin({
    command: process.execPath,
    args: [FAKE],
    keepMs: 60_000,
    piSettingsPath: join(root, "pi-settings.json"),
    ...extra,
  });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: work,
    store: new MemoryPluginStore({ root: join(root, "store") }),
  });
  return { root, registry, record, clock: { now: Date.now() } };
}

function run(
  env: Env,
  params: Record<string, unknown>,
  options: { readonly objectId?: string; readonly runId?: string; readonly signal?: AbortSignal; readonly access?: JsonValue; readonly receiver?: (line: string) => void } = {},
): Promise<PluginStepResult> {
  return env.registry.runStep("pi/agent", { prompt: "hello", cwd: join(env.root, "work"), keepWorker: true, ...params }, {
    runId: options.runId ?? `run-${Math.random()}`,
    object: { type: "chat", id: options.objectId ?? "chat", data: {} },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.access === undefined ? {} : { access: options.access }),
    ...(options.receiver === undefined ? {} : { receiver: options.receiver }),
  });
}

function records(env: Env) {
  return readKeptWorkers(env.root, "pi");
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function inputs(env: Env): Record<string, unknown>[] {
  if (!existsSync(env.record)) return [];
  return readFileSync(env.record, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a second message is answered by the same kept process", async () => {
  const env = setup();
  const first = await run(env, {});
  expect(first.result).toBe("done");
  const [kept] = records(env);
  expect(kept).toBeDefined();
  const pid = kept?.pid ?? 0;
  expect(alive(pid)).toBe(true);

  const second = await run(env, { prompt: "again" }, { runId: "run-2" });
  expect(second.result).toBe("done");
  const [still] = records(env);
  expect(still?.pid).toBe(pid);
  expect(inputs(env).map((input) => input.prompt)).toEqual(["hello", "again"]);
  expect(alive(pid)).toBe(true);
  await stopAllKeptWorkers({ home: env.root });
  expect(await gone(pid)).toBe(true);
});

test("the kept worker ends itself after the kept time", async () => {
  const env = setup({ keepMs: 800 });
  const first = await run(env, {});
  expect(first.result).toBe("done");
  const pid = records(env)[0]?.pid ?? 0;
  expect(pid).toBeGreaterThan(1);
  expect(await gone(pid)).toBe(true);
  expect(records(env)).toEqual([]);
});

test("each change of what the worker was started with ends it", async () => {
  const changes: Record<string, unknown>[] = [
    { args: ["--model", "fake/other"] },
    { effort: "high" },
    { cwd: join("other", "place") },
    { skills: ["/skills/a"] },
    { mcpServers: { notes: { command: "/bin/notes", args: [] } } },
  ];
  for (const change of changes) {
    const env = setup();
    const first = await run(env, {});
    expect(first.result).toBe("done");
    const oldPid = records(env)[0]?.pid ?? 0;
    if (typeof change.cwd === "string") mkdirSync(join(env.root, change.cwd), { recursive: true });
    const params = typeof change.cwd === "string" ? { ...change, cwd: join(env.root, change.cwd) } : change;
    const second = await run(env, params, { runId: "run-2" });
    expect(second.result).toBe("done");
    const newPid = records(env)[0]?.pid ?? 0;
    expect(newPid).not.toBe(oldPid);
    expect(await gone(oldPid)).toBe(true);
    await stopAllKeptWorkers({ home: env.root });
  }
});

test("a changed access profile also starts a new worker", async () => {
  const env = setup();
  const first = await run(env, {}, { access: { denyCommands: ["one"] } });
  expect(first.result).toBe("done");
  const oldPid = records(env)[0]?.pid ?? 0;
  const second = await run(env, {}, { access: { denyCommands: ["two"] }, runId: "run-2" });
  expect(second.result).toBe("done");
  expect(records(env)[0]?.pid).not.toBe(oldPid);
  expect(await gone(oldPid)).toBe(true);
  await stopAllKeptWorkers({ home: env.root });
});

test("a kept worker receives this reply's access, not the previous one's", async () => {
  const env = setup();
  const first = await run(env, {}, { access: { denyCommands: ["same"] } });
  expect(first.result).toBe("done");
  const pid = records(env)[0]?.pid ?? 0;
  const grant = { waitId: "w1", kind: "command", value: "git push", cwd: join(env.root, "work") };
  const second = await run(env, {}, { access: { denyCommands: ["same"], grants: [grant] }, runId: "run-2" });
  expect(second.result).toBe("done");
  expect(records(env)[0]?.pid).toBe(pid);
  const seen = inputs(env);
  const access = seen[1]?.["access"] as { readonly denyCommands?: readonly string[]; readonly grants?: unknown };
  expect(access.denyCommands).toContain("same");
  expect(access.denyCommands).toContain("sudo");
  expect(access.grants).toEqual([grant]);
  await stopAllKeptWorkers({ home: env.root });
});

test("a killed kept worker is given up silently and the message gets a normal reply", async () => {
  const env = setup();
  const first = await run(env, {});
  expect(first.result).toBe("done");
  const oldPid = records(env)[0]?.pid ?? 0;
  process.kill(oldPid, "SIGKILL");
  expect(await gone(oldPid)).toBe(true);

  const second = await run(env, { prompt: "after the kill" }, { runId: "run-2" });
  expect(second.result).toBe("done");
  const data = second.data ?? {};
  expect("reason" in data).toBe(false);
  const newPid = records(env)[0]?.pid ?? 0;
  expect(newPid).not.toBe(oldPid);
  expect(inputs(env)[1]?.["prompt"]).toBe("after the kill");
  await stopAllKeptWorkers({ home: env.root });
});

test("a kept worker that does not answer its first line is given up silently", async () => {
  const env = setup({ keptFirstLineMs: 80 });
  const hang = join(env.root, "hang-once");
  process.env["FAKE_KEEP_HANG_ONCE"] = hang;
  const first = await run(env, {});
  expect(first.result).toBe("done");
  const oldPid = records(env)[0]?.pid ?? 0;
  writeFileSync(hang, "");

  const second = await run(env, { prompt: "still here" }, { runId: "run-2" });
  expect(second.result).toBe("done");
  const data = second.data ?? {};
  expect("reason" in data).toBe(false);
  expect(await gone(oldPid)).toBe(true);
  const newPid = records(env)[0]?.pid ?? 0;
  expect(newPid).not.toBe(oldPid);
  expect(inputs(env)[1]?.["prompt"]).toBe("still here");
  await stopAllKeptWorkers({ home: env.root });
});

test("the fourth worker ends the one that has been idle longest", async () => {
  const env = setup();
  const pids: number[] = [];
  for (const id of ["A", "B", "C", "D"]) {
    const result = await run(env, {}, { objectId: id, runId: `run-${id}` });
    expect(result.result).toBe("done");
    pids.push(records(env).find((record) => record.scope === `chat:${id}`)?.pid ?? 0);
  }
  expect(records(env)).toHaveLength(3);
  expect(await gone(pids[0] ?? 0)).toBe(true);
  for (const pid of pids.slice(1)) expect(alive(pid)).toBe(true);
  await stopAllKeptWorkers({ home: env.root });
});

test("serve stop ends every kept worker", async () => {
  const env = setup();
  const first = await run(env, {}, { objectId: "A" });
  const second = await run(env, {}, { objectId: "B", runId: "run-B" });
  expect(first.result).toBe("done");
  expect(second.result).toBe("done");
  const pids = records(env).map((record) => record.pid);
  expect(pids).toHaveLength(2);
  await stopAllKeptWorkers({ home: env.root });
  for (const pid of pids) expect(await gone(pid)).toBe(true);
  expect(records(env)).toEqual([]);
});

test("a failed reply keeps none", async () => {
  const env = setup();
  process.env["FAKE_KEEP_FAIL"] = "1";
  const result = await run(env, {});
  expect(result.result).toBe("failed");
  expect(records(env)).toEqual([]);
});

test("a stopped reply keeps none", async () => {
  const env = setup();
  process.env["FAKE_KEEP_HANG"] = "1";
  const controller = new AbortController();
  const result = await run(
    env,
    {},
    {
      signal: controller.signal,
      receiver: (line) => {
        if ((JSON.parse(line) as { type?: string }).type === "session") controller.abort();
      },
    },
  );
  expect(result.result).toBe("interrupted");
  expect(records(env)).toEqual([]);
});
