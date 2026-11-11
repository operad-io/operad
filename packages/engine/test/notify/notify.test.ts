import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  Notifier,
  NOTIFIED_FACT,
  ensureHttpToken,
  openLog,
  type HookOutcome,
  type HookRunner,
  type LogBackend,
  type NotifyConfig,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const ON: NotifyConfig = { command: "true", on: ["waiting"] };

async function openFixture(): Promise<{
  readonly root: string;
  readonly home: string;
  readonly log: LogBackend;
}> {
  const root = await tempRoot();
  return { root, home: root, log: openLog({ backend: "jsonl", path: join(root, "store") }) };
}

async function waitOn(
  log: LogBackend,
  object: string,
  waitId = "ask:1",
  prompt = "Approve?",
): Promise<string> {
  const run = await log.startRun("demo-flow", object);
  await log.append(run.runId, 0, [
    {
      kind: "waiting_for_person",
      payload: { waitId, step: "ask", prompt, choices: ["yes"], waitKind: "step", effectId: null },
      cause: "test",
    },
  ]);
  return run.runId;
}

function counting(
  outcome: Partial<HookOutcome> = {},
): { readonly run: HookRunner; readonly calls: Record<string, string>[] } {
  const calls: Record<string, string>[] = [];
  return {
    calls,
    run: async (_line, env) => {
      calls.push({ ...env });
      return {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        error: undefined,
        tail: [],
        ...outcome,
      };
    },
  };
}

describe("notify", () => {
  test("a waiting task runs the command once with the four variables", async () => {
    const { home, root, log } = await openFixture();
    await waitOn(log, "task:T-1", "ask:1", "Approve the plan?");
    const out = join(root, "env.txt");
    const notifier = new Notifier({
      home,
      log,
      config: { command: `env > '${out}'`, on: ["waiting"] },
      titleOf: async () => "Fix the build",
    });
    await notifier.pass();
    const env = Object.fromEntries(
      readFileSync(out, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env.OPERAD_ID).toBe("task:T-1");
    expect(env.OPERAD_TITLE).toBe("Fix the build");
    expect(env.OPERAD_REASON).toBe("Approve the plan?");
    expect(env.OPERAD_LINK).toBe("operad://objects/task%3AT-1");
  });

  test("the command runs in the operad home", async () => {
    const { home, root, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const out = join(root, "cwd.txt");
    const notifier = new Notifier({
      home,
      log,
      config: { command: `pwd -P > '${out}'`, on: ["waiting"] },
    });
    await notifier.pass();
    expect(readFileSync(out, "utf8").trim()).toBe(realpathSync(home));
  });

  test("the token is not in the command's environment", async () => {
    const { home, root, log } = await openFixture();
    const token = (await ensureHttpToken(home)).token;
    await waitOn(log, "task:T-1");
    const out = join(root, "env.txt");
    await new Notifier({
      home,
      log,
      config: { command: `env > '${out}'`, on: ["waiting"] },
    }).pass();
    expect(readFileSync(out, "utf8")).not.toContain(token);
  });

  test("a restart of serve does not notify again for the same wait", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const first = counting();
    await new Notifier({ home, log, config: ON, run: first.run }).pass();
    expect(first.calls).toHaveLength(1);

    const second = counting();
    const restarted = new Notifier({ home, log, config: ON, run: second.run });
    await restarted.pass();
    await restarted.pass();
    expect(second.calls).toHaveLength(0);

    const facts: string[] = [];
    for await (const fact of log.readGlobal()) facts.push(fact.kind);
    expect(facts.filter((kind) => kind === NOTIFIED_FACT)).toHaveLength(1);
  });

  test("a wait the plugin answers itself sends no notice and is noticed later if it stays", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    let automatic = true;
    const sent = counting();
    const notifier = new Notifier({
      home,
      log,
      config: ON,
      run: sent.run,
      answeredAutomatically: async () => automatic,
    });
    await notifier.pass();
    expect(sent.calls).toHaveLength(0);
    automatic = false;
    await notifier.pass();
    expect(sent.calls).toHaveLength(1);
  });

  test("a new wait on the same run notifies again", async () => {
    const { home, log } = await openFixture();
    const runId = await waitOn(log, "task:T-1", "ask:1");
    const hook = counting();
    const notifier = new Notifier({ home, log, config: ON, run: hook.run });
    await notifier.pass();
    await log.append(runId, 1, [
      {
        kind: "person_answered",
        payload: { waitId: "ask:1", step: "ask", choice: "yes", note: null },
        cause: "test",
      },
      {
        kind: "waiting_for_person",
        payload: {
          waitId: "ask:2",
          step: "ask",
          prompt: "Again?",
          choices: ["yes"],
          waitKind: "step",
          effectId: null,
        },
        cause: "test",
      },
    ]);
    await notifier.pass();
    expect(hook.calls.map((call) => call.OPERAD_REASON)).toEqual(["Approve?", "Again?"]);
  });

  test("a failing command is logged with its exit code and stderr tail, and not retried", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const logs: string[] = [];
    const config: NotifyConfig = {
      command: "echo boom >&2; exit 3",
      on: ["waiting"],
    };
    const notifier = new Notifier({ home, log, config, onLog: (m) => logs.push(m) });
    await notifier.pass();
    await notifier.pass();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("exited 3");
    expect(logs[0]).toContain("boom");

    const restarted = counting();
    await new Notifier({ home, log, config: ON, run: restarted.run }).pass();
    expect(restarted.calls).toHaveLength(0);
  });

  test("a command that outlives its limit is stopped, logged and not retried", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const logs: string[] = [];
    const notifier = new Notifier({
      home,
      log,
      config: { command: "sleep 30", on: ["waiting"] },
      timeoutMs: 300,
      onLog: (m) => logs.push(m),
    });
    await notifier.pass();
    expect(logs[0]).toContain("timed out");
    const again = counting();
    await new Notifier({ home, log, config: ON, run: again.run }).pass();
    expect(again.calls).toHaveLength(0);
  });

  test("crash after the command, before the fact: one extra notice on the next serve", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const first = counting();
    const logs: string[] = [];
    await new Notifier({
      home,
      log,
      config: ON,
      run: first.run,
      onLog: (m) => logs.push(m),
      record: async () => {
        throw new Error("disk gone");
      },
    }).pass();
    expect(first.calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("could not record");

    const second = counting();
    const next = new Notifier({ home, log, config: ON, run: second.run });
    await next.pass();
    await next.pass();
    expect(second.calls).toHaveLength(1);

    const third = counting();
    await new Notifier({ home, log, config: ON, run: third.run }).pass();
    expect(third.calls).toHaveLength(0);
  });

  test("crash before the command: nothing is recorded and the next serve sends it", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const crashing = new Notifier({
      home,
      log,
      config: ON,
      run: async () => {
        throw new Error("killed");
      },
    });
    await expect(crashing.pass()).rejects.toThrow("killed");

    const next = counting();
    await new Notifier({ home, log, config: ON, run: next.run }).pass();
    expect(next.calls).toHaveLength(1);
  });

  test("stopping serve cancels a running command and records nothing", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const notifier = new Notifier({
      home,
      log,
      config: ON,
      run: (_line, _env, signal) =>
        new Promise<HookOutcome>((resolve) => {
          started();
          signal.addEventListener("abort", () =>
            resolve({ exitCode: null, timedOut: false, cancelled: true, error: undefined, tail: [] }),
          );
        }),
    });
    const pass = notifier.pass();
    await running;
    await notifier.stop();
    await pass;

    const next = counting();
    await new Notifier({ home, log, config: ON, run: next.run }).pass();
    expect(next.calls).toHaveLength(1);
  });

  test("no command, or no waiting trigger, runs nothing", async () => {
    const { home, log } = await openFixture();
    await waitOn(log, "task:T-1");
    const hook = counting();
    await new Notifier({
      home,
      log,
      config: { command: null, on: ["waiting"] },
      run: hook.run,
    }).pass();
    await new Notifier({
      home,
      log,
      config: { command: "true", on: [] },
      run: hook.run,
    }).pass();
    expect(hook.calls).toHaveLength(0);
  });

  test("a run that is not waiting for a person is not announced", async () => {
    const { home, log } = await openFixture();
    const run = await log.startRun("demo-flow", "task:T-2");
    await log.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: "demo-flow" }, cause: "test" },
    ]);
    const hook = counting();
    await new Notifier({ home, log, config: ON, run: hook.run }).pass();
    expect(hook.calls).toHaveLength(0);
  });
});
