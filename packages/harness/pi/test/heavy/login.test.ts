/**
 * `pi/login`: the provider route, pi's own prompts and notices, and the model
 * after the login (ADR 0023 D11). A fake child speaks the line protocol; the
 * pi library itself is not started here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  defineFlow,
  listPending,
  openLog,
  recordAnswer,
  type AskTimer,
  type Fact,
  type LogBackend,
} from "@operad-io/engine";
import { createPiHarnessPlugin } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../process/test/support.ts";

afterAll(cleanupTempRoots);

const FAKE = fileURLToPath(new URL("../fake-login-worker.ts", import.meta.url));
const ACTOR = { via: "cli", id: "me" } as const;
const OBJECT = "bot:default";

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

  get count(): number {
    return this.fires.length;
  }

  /** Waits until at least `n` timers have been armed. */
  async until(n: number): Promise<void> {
    while (this.fires.length < n) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  fire(): void {
    this.fires.at(-1)?.();
  }
}

const flow = defineFlow({
  name: "test:login",
  entry: "login",
  steps: [
    {
      id: "login",
      kind: "plugin",
      params: { use: "pi/login", params: {} },
      replay: "unsafe",
      next: { done: "done", failed: "failed", interrupted: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

function count(list: readonly Fact[], kind: string): number {
  return list.filter((fact) => fact.kind === kind).length;
}

function waitForLog(log: LogBackend, check: () => Promise<boolean>): Promise<void> {
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

async function setup() {
  const root = await tempRoot();
  const plugin = createPiHarnessPlugin({
    loginCommand: process.execPath,
    loginArgs: [FAKE],
    loginTimeoutMs: 20_000,
    piSettingsPath: join(root, "pi-settings.json"),
  });
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: root,
    store: new MemoryPluginStore({ root: join(root, "store") }),
    settings: {
      pi: {
        models: ["openai-codex/a", "openai-codex/b", "openai/m"],
        model: "openai-codex/b",
      },
    },
  });
  const log = openLog({ path: join(root, "log", "log.sqlite") });
  const info = await log.startRun(flow.name, OBJECT);
  const runner = (timer: FakeTimer): Runner =>
    new Runner({
      log,
      flow,
      runId: info.runId,
      registry,
      params: null,
      askTimer: timer.timer,
    });
  const opened = async (n: number): Promise<void> =>
    waitForLog(log, async () => count(await facts(log, info.runId), "ask_opened") >= n);
  return { root, log, registry, runId: info.runId, runner, opened };
}

describe("pi/login", () => {
  test("the provider route, the pasted redirect URL and the model are three questions, and the secret never reaches a fact", async () => {
    const env = await setup();
    try {
      const run = env.runner(new FakeTimer()).run();
      await env.opened(1);

      let pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.choices).toContain("openai-codex");
      expect(pending[0]?.choices).toContain("openai");
      // Only ChatGPT's subscription is offered for openai-codex, and Anthropic
      // has only its API key (ADR 0023 D11).
      expect(pending[0]?.choiceInfo?.["openai-codex"]?.role).toBe("primary");
      expect(pending[0]?.choiceInfo?.["openai-codex"]?.label).toBe("OpenAI (ChatGPT Plus/Pro)");
      expect(pending[0]?.choiceInfo?.["anthropic"]?.label).toBe("Anthropic API key");
      const firstWait = pending[0]?.waitId;
      if (firstWait === undefined) throw new Error("no wait");

      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: firstWait,
        choice: "openai-codex",
        actor: ACTOR,
      });
      await env.opened(2);

      pending = await listPending(env.log, env.registry);
      const redirect = pending[0]?.questions?.[0];
      expect(redirect).toMatchObject({
        id: "redirect",
        freeText: true,
        secret: true,
      });
      expect(redirect?.url?.startsWith("https://auth.openai.com/oauth/authorize")).toBe(true);
      expect(pending[0]?.choices).toEqual([]);
      const secondWait = pending[0]?.waitId;
      if (secondWait === undefined) throw new Error("no redirect wait");

      const secret = "http://localhost:1455/auth/callback?code=secret-code&state=0123456789abcdef";
      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: secondWait,
        choice: undefined,
        answers: [{ id: "redirect", text: secret }],
        actor: ACTOR,
      });
      await env.opened(3);

      pending = await listPending(env.log, env.registry);
      expect(pending[0]?.choices).toEqual(["openai-codex/a", "openai-codex/b"]);
      expect(pending[0]?.choiceInfo?.["openai-codex/b"]?.role).toBe("primary");
      const thirdWait = pending[0]?.waitId;
      if (thirdWait === undefined) throw new Error("no model wait");

      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: thirdWait,
        choice: "openai-codex/b",
        actor: ACTOR,
      });
      expect(await run).toBe("ended");

      const list = await facts(env.log, env.runId);
      const result = list.find((fact) => fact.kind === "step_result");
      expect(result?.payload).toMatchObject({
        result: "done",
        data: { provider: "openai-codex", model: "openai-codex/b" },
      });
      expect(JSON.stringify(list.filter((fact) => fact.kind !== "step_result"))).not.toContain("secret-code");
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("an API-key provider asks for its key in a secret field and gets its own model list", async () => {
    const env = await setup();
    try {
      const run = env.runner(new FakeTimer()).run();
      await env.opened(1);
      const first = (await listPending(env.log, env.registry))[0];
      if (first?.waitId === undefined) throw new Error("no wait");
      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: first.waitId,
        choice: "openai",
        actor: ACTOR,
      });
      await env.opened(2);

      const pending = await listPending(env.log, env.registry);
      expect(pending[0]?.questions?.[0]).toMatchObject({
        id: "value",
        text: "Enter openai API key",
        secret: true,
        freeText: true,
      });
      const second = pending[0];
      if (second?.waitId === undefined) throw new Error("no key wait");
      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: second.waitId,
        choice: undefined,
        answers: [{ id: "value", text: "sk-not-a-real-key" }],
        actor: ACTOR,
      });
      await env.opened(3);

      const models = (await listPending(env.log, env.registry))[0];
      expect(models?.choices).toEqual(["openai/m"]);
      if (models?.waitId === undefined) throw new Error("no model wait");
      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: models.waitId,
        choice: "openai/m",
        actor: ACTOR,
      });
      expect(await run).toBe("ended");
      const result = (await facts(env.log, env.runId)).find((fact) => fact.kind === "step_result");
      expect(result?.payload).toMatchObject({ result: "done", data: { provider: "openai", model: "openai/m" } });
      expect(JSON.stringify(await facts(env.log, env.runId))).not.toContain("sk-not-a-real-key");
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("an address that is not the ChatGPT login address ends the login before it is shown", async () => {
    const previous = process.env.FAKE_LOGIN_URL;
    process.env.FAKE_LOGIN_URL = "evil";
    const env = await setup();
    try {
      const run = env.runner(new FakeTimer()).run();
      await env.opened(1);
      const first = (await listPending(env.log, env.registry))[0];
      if (first?.waitId === undefined) throw new Error("no wait");
      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: first.waitId,
        choice: "openai-codex",
        actor: ACTOR,
      });
      expect(await run).toBe("ended");
      const list = await facts(env.log, env.runId);
      const result = list.find((fact) => fact.kind === "step_result");
      expect(JSON.stringify(result?.payload)).toContain("not the login address");
      expect(JSON.stringify(list)).not.toContain("evil.example");
    } finally {
      if (previous === undefined) delete process.env.FAKE_LOGIN_URL;
      else process.env.FAKE_LOGIN_URL = previous;
      await env.log.close();
    }
  }, 30_000);

  test("a redirect question the person leaves alone ends the login as cancelled", async () => {
    const env = await setup();
    try {
      const timer = new FakeTimer();
      const run = env.runner(timer).run();
      await env.opened(1);
      const first = (await listPending(env.log, env.registry))[0];
      if (first?.waitId === undefined) throw new Error("no wait");
      const before = timer.count;
      await recordAnswer({
        log: env.log,
        runId: env.runId,
        waitId: first.waitId,
        choice: "openai-codex",
        actor: ACTOR,
      });
      await env.opened(2);
      await timer.until(before + 1);
      timer.fire();
      expect(await run).toBe("ended");
      const result = (await facts(env.log, env.runId)).find((fact) => fact.kind === "step_result");
      expect(JSON.stringify(result?.payload)).toContain("cancelled");
    } finally {
      await env.log.close();
    }
  }, 30_000);
});
