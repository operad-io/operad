/**
 * A chat's question with a structured form (ADR 0026 D6): a step asks one or
 * more questions, the pending item carries them, and the person's answer per
 * question reaches the step. A client that knows only a choice still answers a
 * one-question form.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AskTimeoutError,
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
  type JsonValue,
  type LogBackend,
} from "../../src/index.ts";
import plugin from "../fixtures/plugins/ask.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const ACTOR = { via: "cli", id: "me" } as const;

class FakeTimer {
  readonly calls: number[] = [];
  private readonly fires: (() => void)[] = [];
  private waiters: (() => void)[] = [];

  readonly timer: AskTimer = (ms, fire) => {
    this.calls.push(ms);
    this.fires.push(fire);
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) waiter();
    return () => undefined;
  };

  armed(): Promise<void> {
    if (this.calls.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  fire(): void {
    this.fires.at(-1)?.();
  }
}

const FORM = [
  {
    id: "loader",
    header: "Loader",
    text: "How should it load?",
    choices: [
      { label: "Built-in", description: "use the built-in loader" },
      { label: "Dynamic", description: "load it dynamically" },
    ],
  },
];

const TWO = [
  ...FORM,
  {
    id: "name",
    text: "What name?",
    freeText: true,
  },
];

interface Env {
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  create(flow: string, name: string, extra?: Record<string, unknown>): Promise<string>;
  runner(runId: string, timer: FakeTimer): Runner;
  opened(runId: string): Promise<string>;
  close(): Promise<void>;
}

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

function payloadOf(list: readonly Fact[], kind: string): Record<string, unknown> {
  const fact = list.find((item) => item.kind === kind && typeof item.payload === "object" && item.payload !== null);
  const payload = fact?.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

function stepResult(list: readonly Fact[], step: string): Record<string, unknown> {
  const fact = [...list].reverse().find(
    (item) =>
      item.kind === "step_result" &&
      typeof item.payload === "object" &&
      item.payload !== null &&
      !Array.isArray(item.payload) &&
      (item.payload as Record<string, unknown>).step === step,
  );
  const payload = fact?.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`no result for ${step}`);
  }
  return payload as Record<string, unknown>;
}

async function setup(): Promise<Env> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const flags = join(root, "flags");
  mkdirSync(flags, { recursive: true });
  const storeRoot = join(root, "store");
  const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
  const registry = new PluginRegistry([plugin], {
    home,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
  });
  const flows = new Map<string, string>();
  const params = new Map<string, Record<string, unknown>>();
  return {
    log,
    registry,
    async create(flow, name, extra = {}) {
      const info = await log.startRun(flow, `job:${name}`);
      flows.set(info.runId, flow);
      params.set(info.runId, { name, dir: flags, ...extra });
      return info.runId;
    },
    runner(runId, timer) {
      const flow = flows.get(runId);
      const found = flow === undefined ? undefined : registry.flow(flow);
      if (found === undefined) throw new Error(`no flow for ${runId}`);
      return new Runner({
        log,
        flow: found.flow,
        runId,
        registry,
        lockRoot: storeRoot,
        params: (params.get(runId) ?? {}) as JsonValue,
        askTimer: timer.timer,
      });
    },
    async opened(runId) {
      let waitId = "";
      await waitUntil(log, async () => {
        const payload = payloadOf(await facts(log, runId), "ask_opened");
        if (typeof payload.waitId === "string") waitId = payload.waitId;
        return waitId.length > 0;
      });
      return waitId;
    },
    close: () => log.close(),
  };
}

function flowOf(env: Env, name: string) {
  const found = env.registry.flow(name);
  if (found === undefined) throw new Error(`no flow ${name}`);
  return found.flow;
}

describe("a form a step asks", () => {
  test("the pending item carries the questions and their choices", async () => {
    const env = await setup();
    try {
      const id = await env.create("ask-wait", "form", { questions: FORM });
      const run = env.runner(id, new FakeTimer()).run();
      const waitId = await env.opened(id);

      const pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.waitId).toBe(waitId);
      expect(pending[0]?.prompt).toBe("How should it load?");
      expect(pending[0]?.questions).toEqual([
        {
          id: "loader",
          header: "Loader",
          text: "How should it load?",
          choices: [
            { label: "Built-in", description: "use the built-in loader" },
            { label: "Dynamic", description: "load it dynamically" },
          ],
        },
      ]);
      // A client that cannot draw the form still gets the one question's labels.
      expect(pending[0]?.choices).toEqual(["Built-in", "Dynamic"]);

      await recordAnswer({
        log: env.log,
        runId: id,
        waitId,
        choice: undefined,
        answers: [{ id: "loader", choices: ["Dynamic"] }],
        actor: ACTOR,
      });
      expect(await run).toBe("ended");

      const list = await facts(env.log, id);
      expect(payloadOf(list, "ask_answered")).toMatchObject({
        choice: null,
        answers: [{ id: "loader", choices: ["Dynamic"] }],
      });
      expect(stepResult(list, "q").data).toMatchObject({
        choice: null,
        answers: [{ id: "loader", choices: ["Dynamic"] }],
      });
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a client that knows only a choice answers a one-question form", async () => {
    const env = await setup();
    try {
      const id = await env.create("ask-wait", "legacy", { questions: FORM });
      const run = env.runner(id, new FakeTimer()).run();
      const waitId = await env.opened(id);
      await recordAnswer({ log: env.log, runId: id, waitId, choice: "Built-in", actor: ACTOR });
      expect(await run).toBe("ended");
      const list = await facts(env.log, id);
      expect(payloadOf(list, "ask_answered")).toMatchObject({
        choice: "Built-in",
        answers: [{ id: "loader", choices: ["Built-in"] }],
      });
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a form of two questions needs one answer per question", async () => {
    const env = await setup();
    try {
      const id = await env.create("ask-wait", "two", { questions: TWO });
      const run = env.runner(id, new FakeTimer()).run();
      const waitId = await env.opened(id);
      const pending = await listPending(env.log, env.registry);
      // A form of more than one question offers no one-choice fallback.
      expect(pending[0]?.choices).toEqual([]);

      await expect(
        recordAnswer({ log: env.log, runId: id, waitId, choice: "Built-in", actor: ACTOR }),
      ).rejects.toThrow(/one answer per question/);
      await expect(
        recordAnswer({
          log: env.log,
          runId: id,
          waitId,
          choice: undefined,
          answers: [{ id: "loader", text: "typed" }],
          actor: ACTOR,
        }),
      ).rejects.toThrow(/free text/);
      await recordAnswer({
        log: env.log,
        runId: id,
        waitId,
        choice: undefined,
        answers: [
          { id: "loader", choices: ["Built-in"] },
          { id: "name", text: "typed" },
        ],
        actor: ACTOR,
      });
      expect(await run).toBe("ended");
      const list = await facts(env.log, id);
      expect(payloadOf(list, "ask_answered")).toMatchObject({
        answers: [
          { id: "loader", choices: ["Built-in"] },
          { id: "name", text: "typed" },
        ],
      });
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a question the person leaves alone is answered skipped", async () => {
    const env = await setup();
    try {
      const id = await env.create("ask-wait", "skip", { questions: TWO });
      const run = env.runner(id, new FakeTimer()).run();
      const waitId = await env.opened(id);
      await recordAnswer({
        log: env.log,
        runId: id,
        waitId,
        choice: undefined,
        answers: [{ id: "loader", choices: ["Built-in"] }],
        actor: ACTOR,
      });
      expect(await run).toBe("ended");
      const list = await facts(env.log, id);
      expect(payloadOf(list, "ask_answered")).toMatchObject({
        answers: [
          { id: "loader", choices: ["Built-in"] },
          { id: "name", skipped: true },
        ],
      });
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a form the grace passed keeps its questions and reaches the step again", async () => {
    const env = await setup();
    try {
      const id = await env.create("ask-form-late", "late", { questions: FORM });
      const timer = new FakeTimer();
      const run = env.runner(id, timer).run();
      const waitId = await env.opened(id);
      await timer.armed();
      timer.fire();
      expect(await run).toBe("waiting");

      const state = await readState(env.log, id);
      expect(state.status).toBe("waiting_person");
      expect(state.wait?.questions).toEqual([
        {
          id: "loader",
          header: "Loader",
          text: "How should it load?",
          choices: [
            { label: "Built-in", description: "use the built-in loader" },
            { label: "Dynamic", description: "load it dynamically" },
          ],
        },
      ]);
      const pending = await listPending(env.log, env.registry);
      expect(pending[0]?.questions).toHaveLength(1);
      expect(pending[0]?.waitId).toBe(waitId);

      await answerRun({
        log: env.log,
        flow: flowOf(env, "ask-form-late"),
        runId: id,
        choice: undefined,
        answers: [{ id: "loader", choices: ["Dynamic"] }],
        actor: ACTOR,
      });
      expect(await env.runner(id, new FakeTimer()).run()).toBe("ended");
      const list = await facts(env.log, id);
      // The answer reaches the step that asked, with the form it answered.
      const late = stepResult(list, "q").data as { late?: Record<string, unknown> };
      expect(late.late).toMatchObject({
        answers: [{ id: "loader", choices: ["Dynamic"] }],
        questions: [{ id: "loader", text: "How should it load?" }],
      });
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a form that carries choices of its own is refused before anyone is asked", async () => {
    const env = await setup();
    try {
      const id = await env.create("ask-wait", "bad", {
        questions: FORM,
        withOwnChoices: true,
      });
      const run = env.runner(id, new FakeTimer()).run();
      expect(await run).toBe("ended");
      const list = await facts(env.log, id);
      expect(list.map((fact) => fact.kind)).not.toContain("ask_opened");
      expect(JSON.stringify(stepResult(list, "q").data)).toContain("a form takes no choices of its own");
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a question without an id or with an empty text is refused", async () => {
    const env = await setup();
    try {
      for (const bad of [
        [{ text: "How?" }],
        [{ id: "a", text: "" }],
        [{ id: "a", text: "How?" }, { id: "a", text: "Again?" }],
      ]) {
        const id = await env.create("ask-wait", `bad-${bad.length}`, { questions: bad });
        const run = env.runner(id, new FakeTimer()).run();
        expect(await run).toBe("ended");
        const list = await facts(env.log, id);
        expect(list.map((fact) => fact.kind)).not.toContain("ask_opened");
        expect(JSON.stringify(stepResult(list, "q").data)).toContain("ask:");
      }
    } finally {
      await env.close();
    }
  }, 30_000);

  test("the timeout the step throws carries the form", () => {
    const error = new AskTimeoutError({
      waitId: "w",
      prompt: "How should it load?",
      choices: [],
      questions: [{ id: "loader", text: "How should it load?" }],
      resume: { session: "s" },
    });
    expect(error.questions).toEqual([{ id: "loader", text: "How should it load?" }]);
  });
});
