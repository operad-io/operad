import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  definePlugin,
  PluginRegistry,
  type PluginStepResult,
} from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  createDevPlugin,
  gateWorktreePath,
  readDevSettings,
  taskData,
  validateDevSettings,
  type DevSettings,
  type FixLevel,
  type TaskData,
} from "../src/index.ts";
import {
  commitIn,
  gitOrThrow,
  makeRemote,
  type RemoteSetup,
} from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

interface ManualClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
  fireTimeouts(): number;
}

/** A clock a test drives: a timeout runs only when the test fires it. */
function manualClock(): ManualClock {
  const timers = new Set<{ readonly handler: () => void }>();
  return {
    setTimeout(handler) {
      const timer = { handler };
      timers.add(timer);
      return timer;
    },
    clearTimeout(handle) {
      timers.delete(handle as { readonly handler: () => void });
    },
    sleep() {
      return Promise.resolve();
    },
    fireTimeouts() {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer.handler();
      return due.length;
    },
  };
}

/** Resolves when the file exists, without polling: it watches the directory. */
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

interface ReviewCall {
  readonly prompt: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly resultPath: string;
}

interface FakeReviewer {
  readonly plugin: ReturnType<typeof definePlugin>;
  readonly calls: ReviewCall[];
}

interface FakeReviewerOptions {
  /** Write an invalid report on the first call of every review round. */
  readonly retryInvalid?: boolean;
}

function fakeReviewer(options: FakeReviewerOptions = {}): FakeReviewer {
  const calls: ReviewCall[] = [];
  const seenResults = new Set<string>();
  let count = 0;
  const plugin = definePlugin({
    name: "fake-reviewer",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(_ctx, params): Promise<PluginStepResult> {
          count += 1;
          const input = params as {
            readonly prompt: string;
            readonly cwd: string;
            readonly args?: readonly string[];
            readonly resultPath: string;
          };
          calls.push({
            prompt: input.prompt,
            cwd: input.cwd,
            args: input.args ?? [],
            resultPath: input.resultPath,
          });
          if (
            options.retryInvalid === true &&
            !seenResults.has(input.resultPath)
          ) {
            seenResults.add(input.resultPath);
            writeFileSync(input.resultPath, "this is not JSON\n");
            return { result: "done", data: {} };
          }
          const mode = input.args?.[0] ?? "none";
          if (mode === "fifo") {
            const made = Bun.spawnSync({
              cmd: ["mkfifo", input.resultPath],
              stdout: "ignore",
              stderr: "ignore",
            });
            if (made.exitCode !== 0) {
              throw new Error(`mkfifo failed for ${input.resultPath}`);
            }
            return { result: "done", data: {} };
          }
          if (mode === "malformed") {
            writeFileSync(
              input.resultPath,
              JSON.stringify({
                findings: [
                  {
                    file: "code.txt",
                    severity: "major",
                    summary: "no line",
                    trigger: "always",
                  },
                ],
                verified: [],
              }),
            );
            return { result: "done", data: {} };
          }
          if (mode === "invalid" || (mode === "invalid-then-valid" && count === 1)) {
            writeFileSync(input.resultPath, "this is not JSON\n");
            return { result: "done", data: {} };
          }
          const finding =
            mode === "minor"
              ? {
                  file: "code.txt",
                  line: 1,
                  severity: "minor",
                  summary: "a minor thing",
                  trigger: "when read",
                }
              : mode === "major"
                ? {
                    file: "code.txt",
                    line: 2,
                    severity: "major",
                    summary: "a real problem",
                    trigger: "when called",
                  }
                : mode === "pre-existing"
                  ? {
                      file: "other.txt",
                      line: 3,
                      severity: "critical",
                      summary: "an old problem",
                      trigger: "when loaded",
                    }
                  : undefined;
          writeFileSync(
            input.resultPath,
            JSON.stringify({
              findings: finding === undefined ? [] : [finding],
              verified: ["the diff"],
            }),
          );
          return { result: "done", data: {} };
        },
      },
    ],
  });
  return { plugin, calls };
}

interface FixtureOptions {
  readonly commands?: readonly string[];
  readonly commandTimeoutSecs?: number;
  readonly reviewerArgs?: readonly string[];
  readonly firstArgs?: readonly string[];
  readonly fixLevel?: FixLevel;
  readonly maxAutoRework?: number;
  readonly maxFileDiffBytes?: number;
  readonly maxDiffBytes?: number;
  /** Make the fake reviewer write an invalid report on every round's first call. */
  readonly retryInvalid?: boolean;
  /** Add one small committed file after the worktree is created. */
  readonly commit?: boolean;
  readonly clock?: ManualClock;
}

interface Fixture {
  readonly root: string;
  readonly remote: RemoteSetup;
  readonly store: ReturnType<typeof storeAt>;
  readonly registry: PluginRegistry;
  readonly reviewer: FakeReviewer;
  readonly taskKey: string;
  readonly taskId: string;
  readonly worktree: string;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, {
    path: remote.repository,
    name: "repository",
  });
  mkdirSync(join(remote.repository, ".operad"), { recursive: true });
  writeFileSync(
    join(remote.repository, ".operad", "dev.json"),
    JSON.stringify(
      {
        name: "repository",
        gate: {
          commands: options.commands ?? ["true"],
          commandTimeoutSecs: options.commandTimeoutSecs ?? 60,
        },
        reviewer: {
          use: "fake-reviewer/agent",
          args: options.reviewerArgs ?? ["none"],
          ...(options.firstArgs === undefined
            ? {}
            : { firstArgs: options.firstArgs }),
          fixLevel: options.fixLevel ?? "major",
          maxFileDiffBytes: options.maxFileDiffBytes ?? 200_000,
          maxDiffBytes: options.maxDiffBytes ?? 1_000_000,
        },
        maxAutoRework: options.maxAutoRework ?? 2,
      },
      null,
      2,
    ),
  );
  const plan = await addPlan(store, {
    repository,
    slug: "plan",
    title: "Plan",
    request: "do the work",
  });
  const task = await addTask(store, {
    plan: plan.id,
    slug: "task",
    title: "Task",
    brief: "Make the code do the thing.",
  });
  const reviewer = fakeReviewer({
    retryInvalid: options.retryInvalid === true,
  });
  const registry = new PluginRegistry(
    [
      createDevPlugin(),
      createShellPlugin(
        options.clock === undefined ? {} : { clock: options.clock },
      ),
      reviewer.plugin,
    ],
    { home: root, cwd: remote.repository, store },
  );
  const taskId = task.id.slice(task.id.indexOf("/") + 1);
  const prepared = await registry.runStep("dev/worktree", {}, {
    runId: "worktree-run",
    object: { type: "task", id: task.id, data: {} },
  });
  if (prepared.result !== "ready") {
    throw new Error(`worktree setup failed: ${JSON.stringify(prepared)}`);
  }
  const worktree = join(remote.repository, ".operad-worktrees", taskId);
  const state: Fixture = {
    root,
    remote,
    store,
    registry,
    reviewer,
    taskKey: task.id,
    taskId,
    worktree,
  };
  if (options.commit !== false) {
    await commitIn(worktree, "code.txt", "line\n", "add code");
  }
  return state;
}

function verify(state: Fixture, runId = "verify-run") {
  return state.registry.runStep("dev/verify", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

function review(state: Fixture, runId = "review-run") {
  return state.registry.runStep("dev/review", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

function rework(state: Fixture, runId = "rework-run") {
  return state.registry.runStep("dev/rework", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

async function taskOf(state: Fixture): Promise<TaskData> {
  const object = await state.store.get("task", state.taskKey);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

async function head(state: Fixture): Promise<string> {
  return gitOrThrow(state.worktree, ["rev-parse", "HEAD"]);
}

describe("dev/verify", () => {
  test("passing commands record the verified commit in a detached gate worktree", async () => {
    const state = await fixture({ commands: ["test -f code.txt"] });
    const sha = await head(state);
    const result = await verify(state);
    expect(result.result).toBe("pass");
    expect(result.data?.verified).toBe(sha);
    const task = await taskOf(state);
    expect(task.attempt?.verified).toBe(sha);
    expect(task.attempt?.verify?.result).toBe("pass");
    expect(task.phase).toBe("review");

    const settings: DevSettings = await readDevSettings(state.remote.repository);
    const gate = gateWorktreePath(state.remote.repository, settings, state.taskId);
    expect(existsSync(gate)).toBe(true);
    expect(gitOrThrow(gate, ["rev-parse", "HEAD"])).toBe(sha);
    expect(gitOrThrow(gate, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  test("a failing command records the command and its log", async () => {
    const state = await fixture({ commands: ["echo nope >&2; exit 4"] });
    const result = await verify(state);
    expect(result.result).toBe("fail");
    expect(result.data?.command).toBe("echo nope >&2; exit 4");
    expect(typeof result.data?.log).toBe("string");
    expect(readFileSync(String(result.data?.log), "utf8")).toContain("nope");
    const task = await taskOf(state);
    expect(task.attempt?.verify?.command).toBe("echo nope >&2; exit 4");
    expect(task.attempt?.verify?.log).toBe(result.data?.log as string);
    expect(task.phase).toBe("review");
  });

  test("a hanging command fails with a timeout", async () => {
    const clock = manualClock();
    const root = await tempRoot();
    const marker = join(root, "started");
    const state = await fixture({
      clock,
      commands: [`trap '' TERM; echo $$ > '${marker}'; sleep 30`],
      commandTimeoutSecs: 5,
    });
    const running = verify(state);
    await waitForFile(marker);
    expect(clock.fireTimeouts()).toBe(1);
    const result = await running;
    expect(result.result).toBe("fail");
    expect(String(result.data?.message)).toContain("stopped after 5s");
    expect((await taskOf(state)).attempt?.verify?.result).toBe("fail");
  });

  test("a replay of the same run keeps the first verified commit", async () => {
    const state = await fixture();
    const first = await verify(state);
    expect(first.result).toBe("pass");
    const sha = first.data?.verified as string;
    await commitIn(state.worktree, "moved.txt", "moved\n", "branch moves");

    const again = await verify(state);
    expect(again.result).toBe("pass");
    expect(again.data?.replayed).toBe(true);
    expect(again.data?.verified).toBe(sha);
    expect((await head(state))).not.toBe(sha);
  });
});

describe("dev/review", () => {
  test("no findings pass", async () => {
    const state = await fixture({ reviewerArgs: ["none"] });
    await verify(state);
    const settings: DevSettings = await readDevSettings(state.remote.repository);
    const gate = gateWorktreePath(state.remote.repository, settings, state.taskId);
    writeFileSync(join(gate, "junk.txt"), "left by an earlier gate\n");
    const result = await review(state);
    expect(result.result).toBe("pass");
    expect(state.reviewer.calls).toHaveLength(1);
    expect(state.reviewer.calls[0]?.cwd).toBe(gate);
    expect(existsSync(join(gate, "junk.txt"))).toBe(false);
    expect(result.data?.findings).toEqual([]);
  });

  test("a minor finding under a major fix level passes", async () => {
    const state = await fixture({
      reviewerArgs: ["minor"],
      fixLevel: "major",
    });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("pass");
    expect(result.data?.counted).toBe(0);
    expect(result.data?.preExisting).toBe(0);
  });

  test("a major finding fails", async () => {
    const state = await fixture({
      reviewerArgs: ["major"],
      fixLevel: "major",
    });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("fail");
    expect(result.data?.counted).toBe(1);
    expect(result.data?.findings).toEqual([
      {
        file: "code.txt",
        line: 2,
        severity: "major",
        summary: "a real problem",
        trigger: "when called",
      },
    ]);
  });

  test("invalid JSON is retried once and the second report passes", async () => {
    const state = await fixture({ reviewerArgs: ["invalid-then-valid"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("pass");
    expect(state.reviewer.calls).toHaveLength(2);
  });

  test("invalid JSON twice fails the review without findings", async () => {
    const state = await fixture({ reviewerArgs: ["invalid"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("invalid_json");
    expect(state.reviewer.calls).toHaveLength(2);
    expect((await taskOf(state)).attempt?.review?.result).toBe("failed");
  });

  test("a finding without a line is an invalid report and is retried", async () => {
    const state = await fixture({ reviewerArgs: ["malformed"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("invalid_json");
    expect(state.reviewer.calls).toHaveLength(2);
    expect((await taskOf(state)).attempt?.review?.findings).toBeUndefined();
  });

  test("a FIFO at the report path fails instead of blocking the gate", async () => {
    const state = await fixture({ reviewerArgs: ["fifo"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain("not a regular file");
    expect(state.reviewer.calls).toHaveLength(2);
  });

  test("a finding on a file the change did not touch is pre-existing and does not count", async () => {
    const state = await fixture({
      reviewerArgs: ["pre-existing"],
      fixLevel: "critical",
    });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("pass");
    expect(result.data?.preExisting).toBe(1);
    expect(result.data?.counted).toBe(0);
    const findings = result.data?.findings as readonly {
      readonly preExisting?: boolean;
      readonly pre_existing?: boolean;
    }[];
    expect(findings[0]?.preExisting).toBe(true);
    expect(findings[0]?.pre_existing).toBe(true);
  });

  test("the reviewer sees the verified commit and not a branch that moved", async () => {
    const state = await fixture({ reviewerArgs: ["none"] });
    const verified = (await verify(state)).data?.verified as string;
    await commitIn(state.worktree, "moved.txt", "moved\n", "branch moves");
    const result = await review(state);
    expect(result.result).toBe("pass");
    const prompt = state.reviewer.calls[0]?.prompt ?? "";
    expect(prompt).toContain(verified);
    expect(prompt).toContain("code.txt");
    expect(prompt).not.toContain("moved.txt");
  });

  test("firstArgs are used for the first review of an attempt", async () => {
    const state = await fixture({
      reviewerArgs: ["none"],
      firstArgs: ["major"],
    });
    await verify(state);
    const first = await review(state, "review-run-1");
    expect(first.result).toBe("fail");
    expect(state.reviewer.calls[0]?.args).toEqual(["major"]);

    const second = await review(state, "review-run-2");
    expect(second.result).toBe("pass");
    expect(state.reviewer.calls[1]?.args).toEqual(["none"]);
  });

  test("the retry after an invalid report keeps the round's arguments", async () => {
    const state = await fixture({
      reviewerArgs: ["later"],
      firstArgs: ["initial"],
      retryInvalid: true,
    });
    await verify(state);

    const first = await review(state, "review-run-1");
    expect(first.result).toBe("pass");
    expect(state.reviewer.calls.map((call) => call.args)).toEqual([
      ["initial"],
      ["initial"],
    ]);

    const second = await review(state, "review-run-2");
    expect(second.result).toBe("pass");
    expect(state.reviewer.calls.map((call) => call.args)).toEqual([
      ["initial"],
      ["initial"],
      ["later"],
      ["later"],
    ]);
  });

  test("an empty diff passes without starting a reviewer", async () => {
    const state = await fixture({ commit: false, reviewerArgs: ["none"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("pass");
    expect(result.data?.reason).toBe("empty");
    expect(state.reviewer.calls).toHaveLength(0);
  });

  test("a vendored 3 MB script is listed once and the code is reviewed", async () => {
    const state = await fixture({
      maxFileDiffBytes: 200_000,
      maxDiffBytes: 1_000_000,
    });
    writeFileSync(
      join(state.worktree, ".gitattributes"),
      "big.min.js linguist-vendored\n",
    );
    writeFileSync(join(state.worktree, "big.min.js"), "x".repeat(3_000_000));
    const lines: string[] = [];
    for (let index = 1; index <= 200; index += 1) {
      lines.push(`const value${index} = ${index};`);
    }
    writeFileSync(join(state.worktree, "many.js"), `${lines.join("\n")}\n`);
    gitOrThrow(state.worktree, ["add", ".gitattributes", "big.min.js", "many.js"]);
    gitOrThrow(state.worktree, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "add a vendored script and code",
    ]);

    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("pass");
    const prompt = state.reviewer.calls[0]?.prompt ?? "";
    expect(prompt).toContain("value200 = 200");
    const listed = prompt
      .split("\n")
      .filter((line) => line.startsWith("- big.min.js "));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("vendored");
    expect(prompt.length).toBeLessThan(100_000);
  });

  test("2 MB of real code fails before a reviewer starts and records the size", async () => {
    const state = await fixture({
      maxFileDiffBytes: 200_000,
      maxDiffBytes: 1_000_000,
    });
    writeFileSync(join(state.worktree, "big.txt"), "a".repeat(2_000_000));
    gitOrThrow(state.worktree, ["add", "big.txt"]);
    gitOrThrow(state.worktree, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "add big code",
    ]);

    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("diff_size");
    expect(Number(result.data?.bytes)).toBeGreaterThan(1_000_000);
    expect(state.reviewer.calls).toHaveLength(0);
    const fact = state.store
      .facts()
      .find((entry) => entry.type === "dev/review_too_large");
    expect(fact).toBeDefined();
    expect(fact?.data.bytes).toBeGreaterThan(1_000_000);
    const largest = fact?.data.largest as readonly { readonly path: string }[];
    expect(largest[0]?.path).toBe("big.txt");
  });
});

describe("dev/rework", () => {
  test("two failures rework and the third waits for a person", async () => {
    const state = await fixture({
      commands: ["false"],
      maxAutoRework: 2,
    });

    const first = await verify(state, "verify-1");
    expect(first.result).toBe("fail");
    const one = await rework(state, "rework-1");
    expect(one.result).toBe("again");
    expect(one.data?.rework).toBe(1);
    expect(one.data?.source).toBe("verify");

    const prepared = await state.registry.runStep("dev/worktree", {}, {
      runId: "worktree-2",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(prepared.result).toBe("ready");
    const second = await verify(state, "verify-2");
    expect(second.result).toBe("fail");
    const two = await rework(state, "rework-2");
    expect(two.result).toBe("again");

    const preparedAgain = await state.registry.runStep("dev/worktree", {}, {
      runId: "worktree-3",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(preparedAgain.result).toBe("ready");
    const third = await verify(state, "verify-3");
    expect(third.result).toBe("fail");
    const three = await rework(state, "rework-3");
    expect(three.result).toBe("ask");
    expect(three.data?.rework).toBe(3);

    const task = await taskOf(state);
    expect(task.phase).toBe("waiting");
    expect(task.reworkStreak).toBe(3);
    expect(task.brief).toContain("## Rework 1 (verify)");
    expect(task.brief).toContain("## Rework 2 (verify)");
    expect(task.brief).toContain("## Rework 3 (verify)");
    expect(task.brief).toContain("The verify command failed: `false`");
    expect(task.brief).toContain(
      "Fix them and nothing else, append commits to the branch, and do not rebase.",
    );
  });

  test("a replay of the same rework run appends and counts nothing", async () => {
    const state = await fixture({ commands: ["false"], maxAutoRework: 2 });
    await verify(state, "gate-run");
    const first = await rework(state, "rework-run");
    expect(first.result).toBe("again");
    expect(first.data?.rework).toBe(1);

    const replayed = await rework(state, "rework-run");
    expect(replayed.result).toBe("again");
    expect(replayed.data?.rework).toBe(1);
    expect(replayed.data?.replayed).toBe(true);

    const task = await taskOf(state);
    expect(task.reworkStreak).toBe(1);
    expect(task.brief.match(/## Rework 1 \(verify\)/g)).toHaveLength(1);
    expect(task.brief).not.toContain("## Rework 2");
  });

  test("a new attempt in the same flow run appends the next rework", async () => {
    const state = await fixture({ commands: ["false"], maxAutoRework: 3 });
    const run = "flow-run";
    const start = () =>
      state.registry.runStep("dev/worktree", {}, {
        runId: run,
        object: { type: "task", id: state.taskKey, data: {} },
      });
    expect((await start()).result).toBe("ready");
    await verify(state, run);
    expect((await rework(state, run)).data?.rework).toBe(1);

    expect((await start()).result).toBe("ready");
    await verify(state, run);
    const second = await rework(state, run);
    expect(second.data?.rework).toBe(2);
    expect(second.data?.replayed).toBeUndefined();

    const task = await taskOf(state);
    expect(task.reworkStreak).toBe(2);
    expect(task.brief.match(/## Rework 2 \(verify\)/g)).toHaveLength(1);
  });

  test("a review failure appends the findings at or above the fix level", async () => {
    const state = await fixture({
      reviewerArgs: ["major", "none"],
      fixLevel: "major",
      maxAutoRework: 2,
    });
    await verify(state);
    const failed = await review(state, "review-1");
    expect(failed.result).toBe("fail");
    const result = await rework(state, "rework-1");
    expect(result.result).toBe("again");
    expect(result.data?.source).toBe("review");
    const task = await taskOf(state);
    expect(task.brief).toContain("## Rework 1 (review)");
    expect(task.brief).toContain("`code.txt:2` major: a real problem — when called");
    expect(task.brief).not.toContain("minor");
  });
});

describe("gate settings", () => {
  test("the defaults are the documented ones", () => {
    const settings = validateDevSettings({});
    expect(settings.gate).toEqual({ commands: [], commandTimeoutSecs: 1800 });
    expect(settings.reviewer).toEqual({
      use: "harness-radian/agent",
      args: [],
      timeoutSecs: 600,
      fixLevel: "major",
      maxFileDiffBytes: 200_000,
      maxDiffBytes: 1_000_000,
    });
    expect(settings.maxAutoRework).toBe(2);
    expect(settings.integration).toEqual({ style: "merge", keyCommands: [] });
    expect(settings.hooks.afterMerge).toContain(
      'git push "$OPERAD_REMOTE" --delete "work/$OPERAD_TASK"',
    );
  });

  test("a bad setting names its field", () => {
    expect(() =>
      validateDevSettings({ gate: { commands: [""], commandTimeoutSecs: 1 } }),
    ).toThrow(/gate\.commands\[0\]/);
    expect(() =>
      validateDevSettings({ reviewer: { fixLevel: "high" } }),
    ).toThrow(/reviewer\.fixLevel/);
    expect(() => validateDevSettings({ maxAutoRework: -1 })).toThrow(
      /maxAutoRework/,
    );
    expect(() =>
      validateDevSettings({ integration: { style: "rebase" } }),
    ).toThrow(/integration\.style/);
    expect(() =>
      validateDevSettings({ integration: { keyCommands: [""] } }),
    ).toThrow(/integration\.keyCommands/);
    expect(() => validateDevSettings({ hooks: { afterMerge: [""] } })).toThrow(
      /hooks\.afterMerge/,
    );
    expect(() => validateDevSettings({ integration: { merge: true } })).toThrow(
      /integration\.merge/,
    );
  });
});

describe("the dev flow", () => {
  test("loads with the gate and the rework edges", async () => {
    const root = await tempRoot();
    const remote = await makeRemote(root);
    const store = storeAt(root);
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: remote.repository,
      store,
    });
    const found = registry.flow("dev");
    expect(found).toBeDefined();
    const steps = found?.flow.steps ?? [];
    const nextOf = (id: string): Readonly<Record<string, string>> => {
      const step = steps.find((candidate) => candidate.id === id);
      if (step === undefined || step.kind === "end") return {};
      return step.next as Readonly<Record<string, string>>;
    };
    expect(nextOf("work")).toEqual({
      done: "verify",
      nothing: "wait",
      failed: "wait",
    });
    expect(nextOf("verify")).toEqual({ pass: "review", fail: "rework" });
    expect(nextOf("review")).toEqual({
      pass: "wait",
      fail: "rework",
      failed: "wait",
    });
    expect(nextOf("rework")).toEqual({ again: "worktree", ask: "wait" });
    expect(nextOf("wait")).toEqual({
      merge: "integrate",
      reject: "worktree",
      interrupted: "end_cancelled",
    });
    expect(nextOf("integrate")).toEqual({
      merged: "cleanup",
      conflict: "worktree",
      fail: "worktree",
      failed: "wait",
    });
    expect(nextOf("cleanup")).toEqual({ done: "end_done" });
  });
});
