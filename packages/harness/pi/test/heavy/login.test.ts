/**
 * `pi/login`: the provider route, pi's own prompts and notices, and the model
 * after the login (ADR 0023 D11). A fake child speaks the line protocol; the
 * pi library itself is not started here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
import { PI_PACKAGE, PI_VERSION, chatgptLoginCommand, homePiPackageDir } from "../../src/pi-install.ts";
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
  test("the first question offers API-key routes only and tells where a ChatGPT plan logs in", async () => {
    const env = await setup();
    try {
      const timer = new FakeTimer();
      const run = env.runner(timer).run();
      await env.opened(1);

      const pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      // pi lists openai-codex with an OAuth login only; operad offers none, so
      // the route is not a choice (ADR 0023 D11). Every API-key route stays.
      expect(pending[0]?.choices).toEqual(["openai", "anthropic"]);
      expect(pending[0]?.choiceInfo?.["openai"]?.label).toBe("OpenAI API key");
      expect(pending[0]?.choiceInfo?.["anthropic"]?.label).toBe("Anthropic API key");
      expect(JSON.stringify(pending[0]?.choiceInfo)).not.toContain("primary");
      const command = pending[0]?.command ?? "";
      // `pi` as found on this machine's PATH, or the plain name when it has none.
      expect(command).toBe(chatgptLoginCommand("pi", { home: env.root, cwd: env.root }));
      expect(pending[0]?.prompt).toBe(
        `Choose a provider to log in with an API key. For a ChatGPT plan, run \`${command}\` instead; operad picks it up once it is done.`,
      );

      await timer.until(1);
      timer.fire();
      expect(await run).toBe("ended");
      const list = await facts(env.log, env.runId);
      expect(JSON.stringify(list)).not.toContain("auth_url");
      expect(JSON.stringify(list)).not.toContain("auth.openai.com");
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("the first question names the bundled pi when pi is not on PATH", async () => {
    const env = await setup();
    const dir = homePiPackageDir(env.root);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: PI_PACKAGE, version: PI_VERSION, exports: { ".": "./dist/index.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
    const bin = join(env.root, "plugins", "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
    chmodSync(join(bin, "pi"), 0o755);
    const empty = join(env.root, "empty");
    mkdirSync(empty);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = empty;
    try {
      const timer = new FakeTimer();
      const run = env.runner(timer).run();
      await env.opened(1);
      const item = (await listPending(env.log, env.registry))[0];
      expect(item?.command).toBe(`${join(bin, "pi")} auth login openai-codex`);
      expect(item?.prompt).toContain(`\`${join(bin, "pi")} auth login openai-codex\``);
      await timer.until(1);
      timer.fire();
      expect(await run).toBe("ended");
    } finally {
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
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
});
