// The hand-over of a secret answer to the step that asked (ADR 0008 D8): the
// order of the answer and the step is forced here, so each case runs the same
// way every time.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  openLog,
  readState,
  recordAnswer,
  serve,
  type AskTimer,
  type Fact,
  type LogBackend,
} from "../../src/index.ts";
import { answerAsk, scanAsks } from "../../src/runner/ask.ts";
import { inputIdFor } from "../../src/log/facts.ts";
import {
  SECRET_ANSWER_STALE_MS,
  SECRET_ANSWER_SWEEP_MS,
  putSecretAnswers,
  sweepSecretAnswers,
} from "../../src/runner/secret-answers.ts";
import plugin from "../fixtures/plugins/ask.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const ACTOR = { via: "cli", id: "me" } as const;
const QUESTION = { id: "key", text: "Enter the key", freeText: true, secret: true as const };
const SECRET = "sk-made-up-first";
const never: AskTimer = () => () => undefined;

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/** The same log with some of its calls replaced. */
function intercept(log: LogBackend, calls: Partial<LogBackend>): LogBackend {
  return new Proxy(log, {
    get(target, key) {
      const source: object = key in calls ? calls : target;
      const value: unknown = Reflect.get(source, key);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

function handedOver(home: string): string[] {
  const directory = join(home, "secrets", "answers");
  return existsSync(directory) ? readdirSync(directory) : [];
}

/** Resolves with the question's wait id once the step has asked it. */
function opened(log: LogBackend, runId: string): Promise<string> {
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const look = async (): Promise<void> => {
      const [waitId] = (await scanAsks(log, runId)).asks.keys();
      if (waitId === undefined) return;
      unsubscribe();
      resolve(waitId);
    };
    unsubscribe = log.subscribe?.(() => void look()) ?? (() => undefined);
    void look();
  });
}

async function setup() {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const storeRoot = join(root, "store");
  const log = openLog({ path: join(storeRoot, "log.sqlite") });
  const registry = new PluginRegistry([plugin], {
    home,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
  });
  const info = await log.startRun("ask-wait", "job:secret");
  const runId = info.runId;
  const found = registry.flow("ask-wait");
  if (found === undefined) throw new Error("no flow");
  /** Runs the step; `view` is the log as the step's process reads it. */
  const run = (view: LogBackend = log, timer: AskTimer = never) =>
    new Runner({
      log: view,
      flow: found.flow,
      runId,
      registry,
      lockRoot: storeRoot,
      params: { name: "secret", dir: root, questions: [QUESTION], onTimeout: "reject_once" },
      askTimer: timer,
    }).run();
  const answer = (text: string, waitId: string, view: LogBackend = log) =>
    recordAnswer({
      log: view,
      home,
      runId,
      waitId,
      choice: undefined,
      answers: [{ id: "key", text }],
      actor: ACTOR,
    });
  /** What the step got back from its question. */
  const received = async (): Promise<unknown> =>
    (await facts(log, runId)).find((fact) => fact.kind === "step_result")?.payload;
  return { home, storeRoot, log, registry, runId, run, answer, received };
}

/**
 * The step's view of the log, held at the moment it has written the answer's
 * fact from the claim and has not yet read the secret.
 */
function heldBeforeReading(log: LogBackend, runId: string, waitId: () => string) {
  const written = gate();
  const release = gate();
  const view = intercept(log, {
    findInput: async (inputId) => {
      const claim = inputIdFor("person", `${runId}:ask:${waitId()}`);
      if (inputId === claim && (await scanAsks(log, runId)).asks.get(waitId())?.status === "answered") {
        written.open();
        await release.opened;
      }
      return log.findInput(inputId);
    },
  });
  return { view, written: written.opened, release: release.open };
}

describe("a secret answer's hand-over", () => {
  test("it is kept when the step writes the answer's fact before the answerer does", async () => {
    const env = await setup();
    try {
      let waitId = "";
      const held = heldBeforeReading(env.log, env.runId, () => waitId);
      const run = env.run(held.view);
      waitId = await opened(env.log, env.runId);
      // The answerer goes on only after the step has written the fact.
      const answerer = intercept(env.log, {
        recordInput: async (...args) => {
          const claim = await env.log.recordInput(...args);
          await held.written;
          return claim;
        },
      });
      await env.answer(SECRET, waitId, answerer);
      held.release();
      expect(await run).toBe("ended");
      expect(await env.received()).toMatchObject({ data: { answers: [{ id: "key", text: SECRET }] } });
      // The step's own result is what the step chose to keep; the answer is not.
      const answered = (await facts(env.log, env.runId)).filter((fact) => fact.kind === "ask_answered");
      const claim = await env.log.findInput(inputIdFor("person", `${env.runId}:ask:${waitId}`));
      expect(JSON.stringify([answered, claim])).not.toContain(SECRET);
      expect(handedOver(env.home)).toEqual([]);
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a second answer that loses the claim is refused and leaves the first one's text", async () => {
    const env = await setup();
    try {
      let waitId = "";
      const held = heldBeforeReading(env.log, env.runId, () => waitId);
      const run = env.run(held.view);
      waitId = await opened(env.log, env.runId);
      // The second answer saw the question open; the first claims it meanwhile.
      const second = intercept(env.log, {
        recordInput: async (...args) => {
          await env.answer(SECRET, waitId);
          await held.written;
          return env.log.recordInput(...args);
        },
      });
      await expect(env.answer("sk-made-up-second", waitId, second)).rejects.toThrow("already answered");
      expect(handedOver(env.home)).toHaveLength(1);
      held.release();
      expect(await run).toBe("ended");
      expect(await env.received()).toMatchObject({ data: { answers: [{ id: "key", text: SECRET }] } });
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("only the owner can read what waits for the step", async () => {
    const env = await setup();
    try {
      let waitId = "";
      const held = heldBeforeReading(env.log, env.runId, () => waitId);
      const run = env.run(held.view);
      waitId = await opened(env.log, env.runId);
      await env.answer(SECRET, waitId);
      await held.written;
      const directory = join(env.home, "secrets", "answers");
      expect(statSync(join(env.home, "secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      const [name] = handedOver(env.home);
      expect(statSync(join(directory, name ?? "")).mode & 0o777).toBe(0o600);
      held.release();
      await run;
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a step whose claimed answer is gone fails instead of reading it as skipped", async () => {
    const env = await setup();
    try {
      let waitId = "";
      const held = heldBeforeReading(env.log, env.runId, () => waitId);
      const run = env.run(held.view);
      waitId = await opened(env.log, env.runId);
      await env.answer(SECRET, waitId);
      await held.written;
      const [name = ""] = handedOver(env.home);
      rmSync(join(env.home, "secrets", "answers", name));
      held.release();
      await run;
      const received = JSON.stringify(await facts(env.log, env.runId));
      expect(received).toContain("the secret answer is no longer there");
      expect(await env.received()).not.toMatchObject({ data: { answers: [{ id: "key", skipped: true }] } });
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("an answer the question closed before leaves nothing behind", async () => {
    const env = await setup();
    try {
      await env.log.append(env.runId, 0, [
        {
          kind: "ask_opened",
          payload: { waitId: "w", effectId: "q:1", step: "q", prompt: "Key?", choices: [], questions: [QUESTION] },
          cause: "test",
        },
      ]);
      const ask = (await scanAsks(env.log, env.runId)).asks.get("w");
      if (ask === undefined) throw new Error("no question");
      // The grace ends between the answerer's look and its claim.
      const late = intercept(env.log, {
        recordInput: async (...args) => {
          await env.log.append(env.runId, 1, [{ kind: "ask_timed_out", payload: { waitId: "w" }, cause: "test" }]);
          return env.log.recordInput(...args);
        },
      });
      await expect(
        answerAsk({
          log: late,
          home: env.home,
          runId: env.runId,
          state: {
            ...(await readState(env.log, env.runId)),
            status: "running",
            effects: { "q:1": "outstanding" },
          },
          ask,
          choice: undefined,
          answers: [{ id: "key", text: SECRET }],
          actor: ACTOR,
        }),
      ).rejects.toThrow("the question is closed");
      expect(handedOver(env.home)).toEqual([]);
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a step that stops waiting removes an answer that was never claimed", async () => {
    const env = await setup();
    try {
      let expire: () => void = () => undefined;
      const armed = gate();
      const run = env.run(env.log, (_ms, fire) => {
        expire = fire;
        armed.open();
        return () => undefined;
      });
      const waitId = await opened(env.log, env.runId);
      await armed.opened;
      // What a process that died before its claim leaves.
      await putSecretAnswers(env.home, env.runId, waitId, [{ id: "key", text: SECRET }]);
      expire();
      expect(await run).toBe("ended");
      expect(handedOver(env.home)).toEqual([]);
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("an answer that cannot name a home to hand it through is refused before it is claimed", async () => {
    const env = await setup();
    try {
      const run = env.run();
      const waitId = await opened(env.log, env.runId);
      await expect(
        recordAnswer({
          log: env.log,
          runId: env.runId,
          waitId,
          choice: undefined,
          answers: [{ id: "key", text: SECRET }],
          actor: ACTOR,
        }),
      ).rejects.toThrow("a secret answer cannot be taken here");
      await env.answer(SECRET, waitId);
      expect(await run).toBe("ended");
      expect(await env.received()).toMatchObject({ data: { answers: [{ id: "key", text: SECRET }] } });
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a running serve removes a left-over answer within a sweep of it turning stale", async () => {
    const env = await setup();
    try {
      let now = 2_000_000_000_000;
      await putSecretAnswers(env.home, "run", "wait", [{ id: "key", text: SECRET }]);
      const [name = ""] = handedOver(env.home);
      // Stale one sweep after serve starts, not before.
      const mtime = now - SECRET_ANSWER_STALE_MS;
      utimesSync(join(env.home, "secrets", "answers", name), mtime / 1000, mtime / 1000);
      const stopped = new AbortController();
      const left: number[] = [];
      await serve({
        home: env.home,
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        signal: stopped.signal,
        clock: () => now,
        spawnRun: () => undefined,
        sleep: async () => undefined,
        onPass: () => {
          left.push(handedOver(env.home).length);
          if (left.length === 2) stopped.abort();
          now += SECRET_ANSWER_SWEEP_MS;
        },
      });
      expect(left).toEqual([1, 0]);
    } finally {
      await env.log.close();
    }
  }, 30_000);

  test("a left-over answer is removed once it is stale, by a sweep and when serve starts", async () => {
    const env = await setup();
    try {
      const age = (name: string, mtime: number): void => {
        utimesSync(join(env.home, "secrets", "answers", name), mtime / 1000, mtime / 1000);
      };
      const now = 2_000_000_000_000;
      await putSecretAnswers(env.home, "run", "wait", [{ id: "key", text: SECRET }]);
      const [name = ""] = handedOver(env.home);
      age(name, now - SECRET_ANSWER_STALE_MS);
      await sweepSecretAnswers(env.home, now);
      expect(handedOver(env.home)).toEqual([name]);

      const stopped = new AbortController();
      stopped.abort();
      await serve({
        home: env.home,
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        signal: stopped.signal,
        clock: () => now + 1_000,
        spawnRun: () => undefined,
      });
      expect(handedOver(env.home)).toEqual([]);
    } finally {
      await env.log.close();
    }
  }, 30_000);
});
