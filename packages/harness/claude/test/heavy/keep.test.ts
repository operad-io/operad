import { afterAll, afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { runAgent } from "@operad-io/harness-process";
import { createClaudeHarnessPlugin } from "../../src/index.ts";
import { assistant, result, systemInit, type FakeScript } from "../fake-claude.ts";
import { alive, waitForGone, waitForPid } from "../../../process/test/support.ts";

const FAKE = fileURLToPath(new URL("../fake-worker.ts", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../fake-claude-process.ts", import.meta.url));
const PI_FAKE = fileURLToPath(new URL("../../../pi/test/fake-kept-worker.ts", import.meta.url));
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await stopAllKeptWorkers({ home: root }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  for (const name of ["FAKE_RECORD", "FAKE_SCRIPT", "FAKE_CLAUDE_PID", "FAKE_CLAUDE_RECORD", "FAKE_KEEP_RECORD"]) {
    delete process.env[name];
  }
});

interface Env {
  readonly root: string;
  readonly registry: PluginRegistry;
  readonly record: string;
}

function script(turns: readonly (readonly unknown[])[]): FakeScript {
  return { turns } as unknown as FakeScript;
}

function firstTurn(text: string): unknown[] {
  return [
    { say: systemInit() },
    { say: assistant("m1", text) },
    { say: result({ result: text }) },
  ];
}

function laterTurn(text: string): unknown[] {
  return [
    { say: assistant("m2", text) },
    { say: result({ result: text }) },
  ];
}

function setup(turns: readonly (readonly unknown[])[], extra: Record<string, unknown> = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "ck-claude-"));
  roots.push(root);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const record = join(root, "record.jsonl");
  process.env["FAKE_RECORD"] = record;
  process.env["FAKE_SCRIPT"] = JSON.stringify(script(turns));
  const plugin = createClaudeHarnessPlugin({
    command: process.execPath,
    args: [FAKE],
    keepMs: 60_000,
    ...extra,
  });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: work,
    store: new MemoryPluginStore({ root: join(root, "store") }),
    onLog: () => undefined,
  });
  return { root, registry, record };
}

function run(
  env: Env,
  params: Record<string, unknown> = {},
  options: {
    readonly objectId?: string;
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly access?: JsonValue;
    readonly receiver?: (line: string) => void;
    readonly asker?: Parameters<PluginRegistry["runStep"]>[2] extends infer T
      ? T extends { readonly asker?: infer A }
        ? A
        : never
      : never;
  } = {},
): Promise<PluginStepResult> {
  return env.registry.runStep(
    "claude/agent",
    { prompt: "hello", cwd: join(env.root, "work"), keepWorker: true, ...params },
    {
      runId: options.runId ?? `run-${Math.random()}`,
      object: { type: "chat", id: options.objectId ?? "chat", data: {} },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.access === undefined ? {} : { access: options.access }),
      ...(options.receiver === undefined ? {} : { receiver: options.receiver }),
      ...(options.asker === undefined ? {} : { asker: options.asker }),
    },
  );
}

function records(env: Env) {
  return readKeptWorkers(env.root, "claude");
}

function entries(env: Env): Record<string, unknown>[] {
  if (!existsSync(env.record)) return [];
  return readFileSync(env.record, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a second message is answered by the same worker and the same claude", async () => {
  const env = setup([firstTurn("one"), laterTurn("two")]);
  const first = await run(env);
  expect(first.result).toBe("done");
  const [kept] = records(env);
  expect(kept).toBeDefined();
  const pid = kept?.pid ?? 0;
  expect(alive(pid)).toBe(true);

  const second = await run(env, { prompt: "again" }, { runId: "run-2" });
  expect(second.result).toBe("done");
  expect((second.data as Record<string, unknown>)["finalMessage"]).toBe("two");
  expect(records(env)[0]?.pid).toBe(pid);
  const spawned = entries(env).filter((entry) => "spawn" in entry);
  expect(spawned).toHaveLength(1);
  const users = entries(env).filter((entry) => "user" in entry || "userLater" in entry);
  expect(users).toHaveLength(2);
  expect(alive(pid)).toBe(true);
  await stopAllKeptWorkers({ home: env.root });
  await waitForGone(pid);
  expect(records(env)).toEqual([]);
});

test("the kept worker ends itself after the kept time", async () => {
  const env = setup([firstTurn("one")], { keepMs: 800 });
  expect((await run(env)).result).toBe("done");
  const pid = records(env)[0]?.pid ?? 0;
  expect(pid).toBeGreaterThan(1);
  await waitForGone(pid, 10_000);
  expect(records(env)).toEqual([]);
});

test("each change of what the worker was started with ends it", async () => {
  const changes: Record<string, unknown>[] = [
    { args: ["--model", "opus"] },
    { effort: "high" },
    { cwd: join("other", "place") },
    { skills: ["/skills/a"] },
    { mcpServers: { notes: { command: "/bin/notes", args: [] } } },
  ];
  for (const change of changes) {
    const env = setup([firstTurn("one"), laterTurn("two")]);
    expect((await run(env)).result).toBe("done");
    const oldPid = records(env)[0]?.pid ?? 0;
    if (typeof change.cwd === "string") mkdirSync(join(env.root, change.cwd), { recursive: true });
    const params = typeof change.cwd === "string" ? { ...change, cwd: join(env.root, change.cwd) } : change;
    expect((await run(env, params, { runId: "run-2" })).result).toBe("done");
    const newPid = records(env)[0]?.pid ?? 0;
    expect(newPid).not.toBe(oldPid);
    await waitForGone(oldPid);
    await stopAllKeptWorkers({ home: env.root });
  }
});

test("a changed access profile also starts a new worker", async () => {
  const env = setup([firstTurn("one"), laterTurn("two")]);
  expect((await run(env, {}, { access: { denyCommands: ["one"] } })).result).toBe("done");
  const oldPid = records(env)[0]?.pid ?? 0;
  expect((await run(env, {}, { access: { denyCommands: ["two"] }, runId: "run-2" })).result).toBe("done");
  expect(records(env)[0]?.pid).not.toBe(oldPid);
  await waitForGone(oldPid);
  await stopAllKeptWorkers({ home: env.root });
});

test("a kept worker receives this reply's grant, not the previous reply's", async () => {
  const ask = {
    ask: { toolName: "Bash", toolUseId: "t1", input: { command: "git push" } },
  };
  const env = setup([
    [firstTurn("one")[0], ask, ...firstTurn("one").slice(1)],
    [{ say: assistant("m2", "two") }, ask, { say: result({ result: "two" }) }],
  ]);
  expect((await run(env, {}, { access: { denyCommands: ["git push"] } })).result).toBe("done");
  const pid = records(env)[0]?.pid ?? 0;
  const second = await run(
    env,
    {},
    {
      runId: "run-2",
      access: {
        denyCommands: ["git push"],
        grants: [{ waitId: "w1", kind: "command", value: "git push" }],
      },
      asker: {
        ask: () => Promise.reject(new Error("this call uses its grant, so nobody is asked")),
        useGrant: () => Promise.resolve(true),
      },
    },
  );
  expect(second.result).toBe("done");
  expect(records(env)[0]?.pid).toBe(pid);
  const replies = entries(env).filter((entry) => "askReply" in entry);
  expect(replies).toHaveLength(2);
  expect(replies[0]?.["answer"]).toMatchObject({ behavior: "deny" });
  expect(replies[1]?.["answer"]).toMatchObject({ behavior: "allow" });
  await stopAllKeptWorkers({ home: env.root });
});

test("a killed kept worker is given up silently and the message gets a normal reply", async () => {
  const env = setup([firstTurn("one"), laterTurn("two")]);
  expect((await run(env)).result).toBe("done");
  const oldPid = records(env)[0]?.pid ?? 0;
  process.kill(oldPid, "SIGKILL");
  await waitForGone(oldPid);

  const second = await run(env, { prompt: "after the kill" }, { runId: "run-2" });
  expect(second.result).toBe("done");
  expect("reason" in (second.data ?? {})).toBe(false);
  const newPid = records(env)[0]?.pid ?? 0;
  expect(newPid).not.toBe(oldPid);
  await stopAllKeptWorkers({ home: env.root });
});

test("the fourth worker ends the one that has been idle longest", async () => {
  const env = setup([firstTurn("one"), laterTurn("two"), laterTurn("three"), laterTurn("four")]);
  const pids: number[] = [];
  for (const id of ["A", "B", "C", "D"]) {
    expect((await run(env, {}, { objectId: id, runId: `run-${id}` })).result).toBe("done");
    pids.push(records(env).find((record) => record.scope === `chat:${id}`)?.pid ?? 0);
  }
  expect(records(env)).toHaveLength(3);
  await waitForGone(pids[0] ?? 0);
  for (const pid of pids.slice(1)) expect(alive(pid)).toBe(true);
  await stopAllKeptWorkers({ home: env.root });
});

test("serve stop ends every kept worker", async () => {
  const env = setup([firstTurn("one"), laterTurn("two")]);
  expect((await run(env, {}, { objectId: "A" })).result).toBe("done");
  expect((await run(env, {}, { objectId: "B", runId: "run-B" })).result).toBe("done");
  const pids = records(env).map((record) => record.pid);
  expect(pids).toHaveLength(2);
  await stopAllKeptWorkers({ home: env.root });
  for (const pid of pids) await waitForGone(pid);
  expect(records(env)).toEqual([]);
});

test("a failed reply keeps none", async () => {
  const env = setup([
    [
      { say: systemInit() },
      { say: result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] }) },
    ],
  ]);
  expect((await run(env)).result).toBe("failed");
  expect(records(env)).toEqual([]);
});

test("a stopped reply keeps none", async () => {
  const env = setup([[{ say: systemInit() }, { hang: true }]]);
  const controller = new AbortController();
  const result = await run(env, {}, {
    signal: controller.signal,
    receiver: (line) => {
      if ((JSON.parse(line) as { type?: string }).type === "session") controller.abort();
    },
  });
  expect(result.result).toBe("interrupted");
  expect(records(env)).toEqual([]);
});

test("the skill plugin lives as long as the kept worker and is removed when it ends", async () => {
  const env = setup([firstTurn("one"), laterTurn("two")]);
  const skillDir = join(env.root, "skills", "s1");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: s1\ndescription: One.\n---\n\nDo it.\n");
  expect((await run(env, { skills: [skillDir] })).result).toBe("done");
  const spawn = entries(env).find((entry) => "spawn" in entry)?.["spawn"] as
    | { plugins: Array<{ dir: string }> }
    | undefined;
  const pluginDir = spawn?.plugins[0]?.dir;
  expect(pluginDir).toBeDefined();
  expect(existsSync(pluginDir ?? "")).toBe(true);

  expect((await run(env, { skills: [skillDir] }, { runId: "run-2" })).result).toBe("done");
  expect(existsSync(pluginDir ?? "")).toBe(true);
  await stopAllKeptWorkers({ home: env.root });
  expect(existsSync(pluginDir ?? "")).toBe(false);
});

test("a kept bun worker and its claude end together, whichever is killed", async () => {
  for (const kill of ["claude", "worker"] as const) {
    const root = mkdtempSync(join(tmpdir(), "ck-process-"));
    roots.push(root);
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    const claudePath = join(root, "claude");
    writeFileSync(claudePath, readFileSync(FAKE_CLAUDE), { mode: 0o755 });
    chmodSync(claudePath, 0o755);
    const pidFile = join(root, "claude.pid");
    process.env["FAKE_CLAUDE_PID"] = pidFile;
    const registry = new PluginRegistry([createClaudeHarnessPlugin({ keepMs: 60_000 })], {
      home: root,
      cwd: work,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      onLog: () => undefined,
      settings: { claude: { command: claudePath } },
    });
    const result = await registry.runStep(
      "claude/agent",
      { prompt: "hello", cwd: work, keepWorker: true },
      { runId: "run-1", object: { type: "chat", id: "K", data: {} } },
    );
    expect(result.result).toBe("done");
    const workerPid = readKeptWorkers(root, "claude")[0]?.pid ?? 0;
    const claudePid = await waitForPid(pidFile);
    expect(alive(workerPid)).toBe(true);
    expect(alive(claudePid)).toBe(true);

    if (kill === "claude") {
      process.kill(claudePid, "SIGKILL");
      await waitForGone(workerPid, 10_000);
    } else {
      process.kill(workerPid, "SIGKILL");
      await waitForGone(claudePid, 10_000);
    }
    await stopAllKeptWorkers({ home: root });
    delete process.env["FAKE_CLAUDE_PID"];
  }
});

test("the limit of three is shared by pi and claude workers in one home", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-shared-"));
  roots.push(root);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  process.env["FAKE_KEEP_RECORD"] = join(root, "keep-inputs.jsonl");
  const runs: Array<{ readonly name: string; readonly scope: string }> = [
    { name: "pi", scope: "chat:A" },
    { name: "pi", scope: "chat:B" },
    { name: "claude", scope: "chat:C" },
    { name: "claude", scope: "chat:D" },
  ];
  const pids: number[] = [];
  for (const item of runs) {
    const outcome = await runAgent({
      command: process.execPath,
      args: [PI_FAKE],
      cwd: work,
      stdin: JSON.stringify({
        prompt: item.name,
        cwd: work,
        authPath: "a",
        modelsPath: "m",
        agentDir: "g",
        sessionDir: "s",
      }),
      keep: { home: root, name: item.name, scope: item.scope, key: "same" },
      wallMs: 30_000,
      stallMs: 30_000,
      signal: new AbortController().signal,
      onLine: () => undefined,
    });
    expect(outcome.exitCode).toBe(0);
    pids.push(readKeptWorkers(root, item.name).find((record) => record.scope === item.scope)?.pid ?? 0);
    expect(pids.at(-1)).toBeGreaterThan(1);
  }
  const all = (["pi", "claude"] as const).flatMap((name) => readKeptWorkers(root, name));
  expect(all).toHaveLength(3);
  await waitForGone(pids[0] ?? 0);
  for (const pid of pids.slice(1)) expect(alive(pid)).toBe(true);
  await stopAllKeptWorkers({ home: root });
});
