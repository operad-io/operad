import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  answerRun,
  listPending,
  openLog,
  readState,
  recordAnswer,
  type AskTimer,
  type Fact,
  type LogBackend,
} from "@operad-io/engine";
import { createPiHarnessPlugin } from "../../src/index.ts";
import { alive, cleanupTempRoots, manualClock, tempRoot, waitForGone, waitForPid } from "@operad-io/harness-process/test-support";

afterAll(cleanupTempRoots);

const FAKE = fileURLToPath(new URL("../fake-lines-worker.ts", import.meta.url));
const ACTOR = { via: "cli", id: "me" } as const;
const ACCESS = { askCommands: ["git push"] };
const OBJECT = "task:T-1";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A grace timer the test fires by hand. */
class FakeTimer {
  private fires: Array<() => void> = [];
  private waiters: Array<() => void> = [];
  readonly timer: AskTimer = (_ms, fire) => {
    this.fires.push(fire);
    for (const waiter of this.waiters.splice(0)) waiter();
    return () => undefined;
  };
  armed(): Promise<void> {
    if (this.fires.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  fire(): void {
    this.fires.at(-1)?.();
  }
}

/** Resolves when `check` holds, looking again after each change to the log. */
function waitUntil(log: LogBackend, check: () => Promise<boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    let busy = false;
    let again = false;
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    const settle = (error?: unknown): void => {
      finished = true;
      unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const look = async (): Promise<void> => {
      if (finished) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          if (await check()) return settle();
        } while (again);
      } catch (error) {
        settle(error);
      } finally {
        busy = false;
      }
    };
    unsubscribe = log.subscribe?.(() => void look()) ?? (() => undefined);
    void look();
  });
}

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

function count(list: readonly Fact[], kind: string): number {
  return list.filter((fact) => fact.kind === kind).length;
}

async function setup() {
  const root = await tempRoot();
  const record = join(root, "record.json");
  const marker = join(root, "marker");
  setEnv("FAKE_PI_MODE", "ask");
  setEnv("FAKE_PI_RECORD", record);
  setEnv("FAKE_PI_MARKER", marker);
  const plugin = createPiHarnessPlugin({ clock: manualClock(), command: process.execPath, args: [FAKE] });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
  });
  const log = openLog({ backend: "sqlite", path: join(root, "log", "log.sqlite") });
  const found = registry.flow("pi:prompt");
  if (found === undefined) throw new Error("the prompt flow is not loaded");
  const info = await log.startRun(found.flow.name, OBJECT);
  const runner = (timer: FakeTimer): Runner =>
    new Runner({
      log,
      flow: found.flow,
      runId: info.runId,
      registry,
      params: { prompt: "push it", cwd: root },
      access: ACCESS,
      askTimer: timer.timer,
    });
  const opened = async (n: number): Promise<void> =>
    waitUntil(log, async () => count(await facts(log, info.runId), "ask_opened") >= n);
  return {
    root,
    log,
    registry,
    runId: info.runId,
    flow: found.flow,
    marker,
    runner,
    opened,
    ack: (): Record<string, unknown> => JSON.parse(readFileSync(`${record}.ack`, "utf8")) as Record<string, unknown>,
    grant: (): Record<string, unknown> => JSON.parse(readFileSync(`${record}.grant`, "utf8")) as Record<string, unknown>,
    input: (): Record<string, unknown> => JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>,
  };
}

describe("pi: a call that must ask a person", () => {
  test("answered within the grace period: the same step goes on and the call goes through once", async () => {
    const env = await setup();
    try {
      const run = env.runner(new FakeTimer()).run();
      await env.opened(1);
      const pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.object).toBe(OBJECT);
      expect(pending[0]?.choices).toEqual(["allow_once", "reject_once"]);
      expect(pending[0]?.prompt).toContain("git push");

      await recordAnswer({ log: env.log, runId: env.runId, choice: "allow_once", actor: ACTOR });
      expect(await run).toBe("ended");

      expect(env.ack()).toEqual({ type: "ask_ack", id: 7, decision: "allow" });
      const list = await facts(env.log, env.runId);
      expect(count(list, "ask_opened")).toBe(1);
      expect(count(list, "ask_answered")).toBe(1);
      expect(count(list, "ask_timed_out")).toBe(0);
      // The step went on: it was never run twice and no permission was kept.
      expect(count(list, "grant_used")).toBe(0);
      expect(list.filter((fact) => fact.kind === "step_entered" && (fact.payload as { step?: string }).step === "agent")).toHaveLength(1);
      expect((await readState(env.log, env.runId)).endedStatus).toBe("done");
      expect(await listPending(env.log, env.registry)).toEqual([]);
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a refusal within the grace period denies the call and the step goes on", async () => {
    const env = await setup();
    try {
      const run = env.runner(new FakeTimer()).run();
      await env.opened(1);
      await recordAnswer({ log: env.log, runId: env.runId, choice: "reject_once", actor: ACTOR });
      expect(await run).toBe("ended");
      expect(env.ack()).toMatchObject({ decision: "deny" });
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("not answered in time: the step ends waiting, the process exits, the one item stays", async () => {
    const env = await setup();
    try {
      const timer = new FakeTimer();
      const run = env.runner(timer).run();
      await env.opened(1);
      await timer.armed();
      const pid = await waitForPid(env.marker);
      expect(alive(pid)).toBe(true);
      timer.fire();
      expect(await run).toBe("waiting");

      // The program was told to stop and is gone.
      await waitForGone(pid);

      const state = await readState(env.log, env.runId);
      expect(state.status).toBe("waiting_person");
      const pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.object).toBe(OBJECT);
      expect(pending[0]?.choices).toEqual(["allow_once", "reject_once"]);
      expect(pending[0]?.prompt).toContain("git push");
      const result = (await facts(env.log, env.runId)).find((fact) => fact.kind === "step_result");
      expect(result?.payload).toMatchObject({
        result: "waiting",
        data: {
          resume: {
            session: "/sessions/one.jsonl",
            grant: { kind: "command", value: "git push origin main", choice: "allow_once" },
          },
        },
      });
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("answered later: the session resumes with the one-time permission, and any other call asks again", async () => {
    const env = await setup();
    try {
      const first = new FakeTimer();
      const run = env.runner(first).run();
      await env.opened(1);
      await first.armed();
      first.fire();
      expect(await run).toBe("waiting");

      await answerRun({ log: env.log, flow: env.flow, runId: env.runId, choice: "allow_once", actor: ACTOR });
      const second = new FakeTimer();
      const again = env.runner(second).run();

      // The resumed step continues the session, with the answer in its prompt,
      // and uses the permission up for the call it covers.
      await env.opened(2);
      const input = env.input();
      expect(input["resumeSession"]).toBe("/sessions/one.jsonl");
      expect(String(input["prompt"])).toContain("You asked: ");
      expect(String(input["prompt"])).toContain("The answer is: allow_once");
      expect(env.grant()).toEqual({ type: "grant_ack", id: 1, used: true });
      const list = await facts(env.log, env.runId);
      expect(count(list, "grant_used")).toBe(1);
      expect(list.find((fact) => fact.kind === "grant_used")?.payload).toMatchObject({ kind: "command", value: "git push origin main" });

      // Another call is not covered: it asks again, and there is one item.
      const pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.object).toBe(OBJECT);
      await second.armed();
      second.fire();
      expect(await again).toBe("waiting");
      expect(count(await facts(env.log, env.runId), "grant_used")).toBe(1);
      expect(await listPending(env.log, env.registry)).toHaveLength(1);
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a refusal that comes late resumes the session without a permission", async () => {
    const env = await setup();
    try {
      const first = new FakeTimer();
      const run = env.runner(first).run();
      await env.opened(1);
      await first.armed();
      first.fire();
      expect(await run).toBe("waiting");

      await answerRun({ log: env.log, flow: env.flow, runId: env.runId, choice: "reject_once", actor: ACTOR });
      const second = new FakeTimer();
      const again = env.runner(second).run();
      // No permission came: the fake asks about the same call again.
      await env.opened(2);
      expect(String(env.input()["prompt"])).toContain("The answer is: reject_once");
      expect((env.input()["access"] as Record<string, unknown>)["grants"]).toBeUndefined();
      await second.armed();
      second.fire();
      expect(await again).toBe("waiting");
      expect(count(await facts(env.log, env.runId), "grant_used")).toBe(0);
    } finally {
      await env.log.close();
    }
  }, 30_000);
});
