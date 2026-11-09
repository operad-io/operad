import { createPoolPlugin } from "@operad-io/pool";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  definePlugin,
  PluginRegistry,
  type PluginStepResult,
} from "@operad-io/engine";
import {
  addPlan,
  addRepository,
  addTask,
  createDevPlugin,
  taskData,
} from "../src/index.ts";
import { PROGRESS_FILE, WIP_MESSAGE } from "../src/progress.ts";
import { stepTestHooks } from "../src/steps.ts";
import { STEP_TIMEOUT_SECS } from "../src/timeouts.ts";
import { validateDevSettings } from "../src/settings.ts";
import { waitingReason } from "../src/announce.ts";
import { gitOrThrow, makeRemote } from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();
afterEach(() => {
  stepTestHooks.workClock = undefined;
});

const LIMIT_MS = STEP_TIMEOUT_SECS * 1000;
const WRAP_MS = Math.floor(LIMIT_MS * 0.85);
const HARD_MS = LIMIT_MS - 30_000;

/** A clock a test drives: a timer runs only when the test moves time past it. */
class ManualClock {
  readonly timers: { readonly handler: () => void; readonly ms: number; live: boolean }[] = [];
  setTimeout(handler: () => void, ms: number): unknown {
    const timer = { handler, ms, live: true };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    const timer = this.timers.find((candidate) => candidate === handle);
    if (timer !== undefined) timer.live = false;
  }
  advanceTo(ms: number): void {
    for (const timer of [...this.timers].sort((a, b) => a.ms - b.ms)) {
      if (timer.live && timer.ms <= ms) {
        timer.live = false;
        timer.handler();
      }
    }
  }
}

type Mode = "wrap-up" | "ignore" | "deaf" | "plain" | "wall" | "commits-note";

interface Seen {
  prompts: string[];
  messages: string[];
  /** Resolves when the harness is running and listening. */
  started: Promise<void>;
  start: () => void;
}

function newSeen(): Seen {
  let start: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  return { prompts: [], messages: [], started, start };
}

function commitFile(cwd: string, name: string, message: string, content = "x\n"): void {
  writeFileSync(join(cwd, name), content);
  gitOrThrow(cwd, ["add", name]);
  gitOrThrow(cwd, ["-c", "user.name=w", "-c", "user.email=w@example.com", "commit", "-qm", message]);
}

function fakeHarness(modes: Mode[], seen: Seen[], runMs?: number) {
  return definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(ctx, params): Promise<PluginStepResult> {
          const input = params as {
            readonly prompt: string;
            readonly cwd: string;
            readonly inbox?: {
              listen(handler: (text: string) => void): () => void;
              begin(limitMs: number): void;
            };
          };
          const mode = modes.shift() ?? "plain";
          const record = newSeen();
          seen.push(record);
          record.prompts.push(input.prompt);
          const aborted = new Promise<void>((resolve) =>
            ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          if (mode === "plain") {
            commitFile(input.cwd, "plain.txt", "plain work");
            return { result: "done", data: {} };
          }
          if (mode === "commits-note") {
            // A worker that did not follow the instruction and committed the note.
            commitFile(input.cwd, PROGRESS_FILE, "oops the note", "left: everything\n");
            return { result: "done", data: {} };
          }
          if (mode === "wall") {
            // The harness's own wall time ended the run before the step's limit.
            writeFileSync(join(input.cwd, "unfinished.txt"), "half\n");
            return { result: "failed", data: { reason: "wall", message: "the harness ran longer than 1s" } };
          }
          if (mode === "wrap-up") {
            input.inbox?.begin(runMs ?? LIMIT_MS);
            const message = new Promise<string>((resolve) => {
              input.inbox?.listen((text) => {
                record.messages.push(text);
                resolve(text);
              });
            });
            record.start();
            await message;
            commitFile(input.cwd, "part.txt", "part one");
            writeFileSync(join(input.cwd, PROGRESS_FILE), "done: part one\nleft: part two\n");
            return { result: "done", data: {} };
          }
          if (mode === "ignore") {
            input.inbox?.listen((text) => record.messages.push(text));
            input.inbox?.begin(LIMIT_MS);
          }
          writeFileSync(join(input.cwd, "unfinished.txt"), "half\n");
          writeFileSync(join(input.cwd, PROGRESS_FILE), "done: half of it\n");
          record.start();
          await aborted;
          return { result: "interrupted", data: { reason: "cancelled" } };
        },
      },
    ],
  });
}

async function fixture(modes: Mode[], extra: Record<string, unknown> = {}, runMs?: number) {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: remote.repository, name: "repository" });
  writeFileSync(
    join(remote.repository, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      remote: "origin",
      mainBranch: "main",
      worktreeRoot: ".operad-worktrees",
      worker: { use: "fake-harness/agent", args: [] },
      workerBrief: ".operad/worker-brief.md",
      ...extra,
    }),
  );
  writeFileSync(join(remote.repository, ".operad", "worker-brief.md"), "Do the work.");
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do the work" });
  const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Write the files." });
  const seen: Seen[] = [];
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), fakeHarness(modes, seen, runMs)],
    { home: root, cwd: remote.repository, store },
  );
  const object = { type: "task", id: task.id, data: {} };
  let visits = 0;
  const worktree = async (): Promise<void> => {
    visits += 1;
    const result = await registry.runStep("dev/worktree", {}, { runId: `worktree-${visits}`, object });
    if (result.result !== "ready") throw new Error(JSON.stringify(result));
  };
  const work = (): ReturnType<typeof registry.runStep> =>
    registry.runStep("dev/work", {}, { runId: `work-${visits}`, object });
  const attempt = async () => {
    const stored = await store.get("task", task.id);
    if (stored === undefined) throw new Error("task disappeared");
    return taskData(stored.data);
  };
  await worktree();
  return { seen, worktree, work, attempt, path: join(remote.repository, ".operad-worktrees", task.id.slice(task.id.indexOf("/") + 1)) };
}

describe("a work step that runs out of time", () => {
  test("the wrap-up message arrives at the share of the limit, not before", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["wrap-up"]);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    clock.advanceTo(WRAP_MS - 1);
    expect(seen.messages).toEqual([]);
    clock.advanceTo(WRAP_MS);
    const result = await running;
    expect(seen.messages).toHaveLength(1);
    expect(seen.messages[0]).toContain(PROGRESS_FILE);
    expect(seen.messages[0]).toContain("Stop starting new things");
    expect(result.result).toBe("done");
  });

  test("a step that commits and writes its note before the limit keeps the note in the history", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["wrap-up"]);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    clock.advanceTo(WRAP_MS);
    const result = await running;
    expect(result.result).toBe("done");
    expect(result.data?.progress).toBe("done: part one\nleft: part two\n");
    expect((await state.attempt()).attempt?.progress).toMatchObject({ timedOut: false });
    // The note is not work: the tree is clean and nothing of it is committed.
    expect(gitOrThrow(state.path, ["status", "--porcelain"])).not.toContain("part.txt");
    expect(gitOrThrow(state.path, ["ls-files"])).not.toContain(PROGRESS_FILE);
  });

  test("a step that ignores the message and times out gets a work-in-progress commit and its note kept", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["ignore"]);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    clock.advanceTo(WRAP_MS);
    expect(seen.messages).toHaveLength(1);
    clock.advanceTo(HARD_MS);
    const result = await running;
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("timeout");
    expect(result.data?.progress).toBe("done: half of it\n");
    expect(gitOrThrow(state.path, ["log", "-1", "--format=%s"])).toBe(WIP_MESSAGE);
    expect(gitOrThrow(state.path, ["show", "--stat", "--format=", "HEAD"])).toContain("unfinished.txt");
    expect(gitOrThrow(state.path, ["show", "--stat", "--format=", "HEAD"])).not.toContain(PROGRESS_FILE);
    expect(readFileSync(join(state.path, PROGRESS_FILE), "utf8")).toBe("done: half of it\n");
    const task = await state.attempt();
    expect(task.phase).toBe("waiting");
    expect(task.attempt?.workTimedOut).toBe(true);
  });

  test("the next attempt's prompt starts with the note and the commits, and the worktree keeps them", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["ignore", "plain"]);
    const first = state.work();
    const one = await waitFor(state.seen, 0);
    await one.started;
    clock.advanceTo(HARD_MS);
    await first;
    await state.worktree();
    expect(existsSync(join(state.path, "unfinished.txt"))).toBe(true);
    const second = await state.work();
    expect(second.result).toBe("done");
    const prompt = state.seen[1]?.prompts[0] ?? "";
    expect(prompt.indexOf("ran out of time")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("ran out of time")).toBeLessThan(prompt.indexOf("Do the work."));
    expect(prompt).toContain("done: half of it");
    expect(prompt).toContain(WIP_MESSAGE);
    // The stale note is gone before the new attempt starts.
    expect(existsSync(join(state.path, PROGRESS_FILE))).toBe(false);
  });

  test("a harness that cannot take messages still times out with a commit, and the next attempt continues", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["deaf", "plain"]);
    const first = state.work();
    const one = await waitFor(state.seen, 0);
    await one.started;
    clock.advanceTo(WRAP_MS);
    expect(one.messages).toEqual([]);
    clock.advanceTo(HARD_MS);
    const result = await first;
    expect(result.data?.reason).toBe("timeout");
    expect(gitOrThrow(state.path, ["log", "-1", "--format=%s"])).toBe(WIP_MESSAGE);
    await state.worktree();
    const second = await state.work();
    expect(second.result).toBe("done");
    expect(state.seen[1]?.prompts[0]).toContain("done: half of it");
  });

  test("a run the harness's own wall time ended is a timeout too: committed, and the next attempt continues", async () => {
    const state = await fixture(["wall", "plain"]);
    const result = await state.work();
    expect(result.data?.reason).toBe("timeout");
    expect(gitOrThrow(state.path, ["log", "-1", "--format=%s"])).toBe(WIP_MESSAGE);
    await state.worktree();
    await state.work();
    expect(state.seen[1]?.prompts[0]).toContain(WIP_MESSAGE);
  });

  test("a note the worker committed anyway is taken out of the branch and still read", async () => {
    const state = await fixture(["commits-note"]);
    const result = await state.work();
    expect(result.result).toBe("done");
    expect(result.data?.progress).toBe("left: everything\n");
    expect(gitOrThrow(state.path, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(PROGRESS_FILE);
    expect(gitOrThrow(state.path, ["status", "--porcelain"])).toBe(`?? ${PROGRESS_FILE}`);
  });

  test("a step that finishes normally leaves the next attempt nothing to read", async () => {
    const state = await fixture(["plain", "plain"]);
    await state.work();
    await state.worktree();
    await state.work();
    expect(state.seen[1]?.prompts[0]).not.toContain("ran out of time");
  });
});

/** Waits until the harness has been called `count + 1` times, without sleeping. */
async function waitFor(seen: Seen[], count: number): Promise<Seen> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    const found = seen[count];
    if (found !== undefined) return found;
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the harness did not start");
}

describe("the limit a harness reports", () => {
  test("nothing is timed from the step's start but the backstop; the wrap-up is timed from the harness's own begin", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["wrap-up"]);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    // The harness began with the step's own limit: the backstop plus the wrap-up and stop.
    expect(clock.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([WRAP_MS, HARD_MS, HARD_MS]);
    clock.advanceTo(WRAP_MS);
    await running;
  });

  test("a harness that reports a shorter wall time is wrapped up and stopped by that wall, not the step's limit", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["wrap-up"], {}, 7_200_000);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    const live = clock.timers.filter((timer) => timer.live).map((timer) => timer.ms);
    expect(live).toContain(Math.floor(7_200_000 * 0.85));
    expect(live).toContain(7_200_000 - 30_000);
    clock.advanceTo(Math.floor(7_200_000 * 0.85));
    expect((await running).result).toBe("done");
    expect(seen.messages).toHaveLength(1);
  });

  test("a harness that never reports a run leaves only the backstop", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["deaf"]);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    expect(clock.timers.map((timer) => timer.ms)).toEqual([HARD_MS]);
    clock.advanceTo(HARD_MS);
    expect((await running).data?.reason).toBe("timeout");
  });
});

describe("work.wrapUpAt", () => {
  test("defaults to 0.85, takes a share between 0 and 1, and refuses anything else", () => {
    expect(validateDevSettings({}).work.wrapUpAt).toBe(0.85);
    expect(validateDevSettings({ work: { wrapUpAt: 0.5 } }).work.wrapUpAt).toBe(0.5);
    for (const bad of [0, 1, 1.5, -0.1, "0.5"]) {
      expect(() => validateDevSettings({ work: { wrapUpAt: bad } })).toThrow(/work\.wrapUpAt/);
    }
    expect(() => validateDevSettings({ work: { other: 1 } })).toThrow(/work\.other/);
  });

  test("the schema describes it", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "dev.schema.json"), "utf8"));
    expect(schema.properties.work.properties.wrapUpAt.description.length).toBeGreaterThan(20);
  });

  test("the share moves the wrap-up message", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["wrap-up"], { work: { wrapUpAt: 0.5 } });
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    expect(clock.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([LIMIT_MS / 2, HARD_MS, HARD_MS]);
    clock.advanceTo(LIMIT_MS / 2);
    await running;
  });
});

describe("the reason a timed-out task waits", () => {
  test("work timed out, with the step's message as the detail", async () => {
    const clock = new ManualClock();
    stepTestHooks.workClock = clock;
    const state = await fixture(["deaf"]);
    const running = state.work();
    const seen = await waitFor(state.seen, 0);
    await seen.started;
    clock.advanceTo(HARD_MS);
    await running;
    const found = waitingReason({ from: "work", result: "failed" }, await state.attempt(), 2, false);
    expect(found.reason).toBe("work timed out");
    expect(found.detail).toContain("work in progress");
  });
});
