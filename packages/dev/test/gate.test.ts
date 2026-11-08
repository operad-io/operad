import { chmodSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide,
  definePlugin,
  evolve,
  FilePluginStore,
  initialState,
  PluginRegistry,
  type KernelState,
  type PluginStepResult,
} from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { setTaskPhase } from "../src/service.ts";
import type { CheckCommand } from "../src/settings.ts";
import { listRerunCounts, recordRerunPasses } from "../src/reruns.ts";
import { anchoredPattern, rerunCommand } from "../src/rerun.ts";
import {
  addPlan,
  addRepository,
  addTask,
  createDevPlugin,
  DEV_MAX_VISITS,
  MAX_REVIEW_WAITS,
  gateWorktreePath,
  readDevSettings,
  reviewTestHooks,
  REVIEW_WAIT_CHUNK_MS,
  STEP_TIMEOUT_SECS,
  splitBrief,
  taskData,
  validateDevSettings,
  workBranch,
  type DevSettings,
  type FixLevel,
  type ReviewRunOutcome,
  type TaskData,
} from "../src/index.ts";
import {
  advanceMain,
  commitIn,
  gitOrThrow,
  makeRemote,
  type RemoteSetup,
} from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, osTempRoot, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

/** FIFOs a fake reviewer made; removed after each test, whether it passed, failed or threw. */
const fifos: string[] = [];
afterEach(() => {
  for (const path of fifos) rmSync(path, { force: true });
});
guardLockHandles();

const REVIEW_CRASH_CHILD = fileURLToPath(
  new URL("./fixtures/review-crash-child.ts", import.meta.url),
);

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
  readonly stallSecs: number | undefined;
}

interface FakeReviewer {
  readonly plugin: ReturnType<typeof definePlugin>;
  readonly calls: ReviewCall[];
}

interface FakeReviewerOptions {
  /** Write an invalid report on the first call of every review round. */
  readonly retryInvalid?: boolean;
  /** Append one line per model call, so a test can count calls across processes. */
  readonly callLog?: string;
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
            readonly stallSecs?: number;
          };
          calls.push({
            prompt: input.prompt,
            cwd: input.cwd,
            args: input.args ?? [],
            stallSecs: input.stallSecs,
            resultPath: input.resultPath,
          });
          if (options.callLog !== undefined) {
            appendFileSync(options.callLog, "call\n");
          }
          // Every call has its own report path; a round is the path without
          // its try number.
          const roundKey = input.resultPath.replace(/-try-\d+\.json$/, "");
          if (
            options.retryInvalid === true &&
            !seenResults.has(roundKey)
          ) {
            seenResults.add(roundKey);
            writeFileSync(input.resultPath, "this is not JSON\n");
            return { result: "done", data: {} };
          }
          const mode = input.args?.[0] ?? "none";
          if (mode === "unavailable") {
            return {
              result: "failed",
              data: {
                reason: "exit",
                modelError: {
                  kind: "unavailable",
                  status: 503,
                  retry_after_secs: null,
                },
                message: "the harness exited 1",
              },
            };
          }
          if (mode === "usage-limit") {
            return {
              result: "failed",
              data: {
                reason: "exit",
                modelError: {
                  kind: "usage_limit",
                  status: null,
                  retry_after_secs: 3600,
                },
                message: "the usage limit is reached",
              },
            };
          }
          if (mode === "429" || (mode === "429-once" && count === 1)) {
            return {
              result: "failed",
              data: {
                reason: "exit",
                message: "the harness exited 1",
                stderr: ["request failed", "error: HTTP 429 Too Many Requests"],
              },
            };
          }
          if (mode === "not-429") {
            // A 429 that is not a rate limit: a count in a line, a duration.
            return {
              result: "failed",
              data: {
                reason: "exit",
                message: "the harness exited 1",
                stderr: ["processed line 429"],
                durationMs: 429,
                finalMessage: "fixed 429 things",
                log: "/tmp/run-429.jsonl",
                exitCode: 1,
              },
            };
          }
          if (mode === "report-then-exit" || mode === "report-then-wall") {
            writeFileSync(
              input.resultPath,
              JSON.stringify({ findings: [], verified: ["the diff"] }),
            );
            return {
              result: "failed",
              data:
                mode === "report-then-wall"
                  ? { reason: "wall", message: "the harness ran longer than 600s" }
                  : { reason: "exit", message: "the harness exited 1" },
            };
          }
          if (mode === "timeout" || (mode === "timeout-once" && count === 1)) {
            return {
              result: "failed",
              data: {
                reason: "wall",
                message: "the harness ran longer than 600s",
              },
            };
          }
          if (mode.startsWith("table:")) {
            const [, harness, file] = mode.split(":");
            if (file === "valid") {
              writeFileSync(
                input.resultPath,
                JSON.stringify({ findings: [], verified: ["t"] }),
              );
            } else if (file === "invalid") {
              writeFileSync(input.resultPath, "this is not JSON\n");
            }
            if (harness === "done") {
              return { result: "done", data: { finalMessage: "last words" } };
            }
            if (harness === "failed") {
              return {
                result: "failed",
                data: {
                  reason: "exit",
                  message: "the harness exited 1",
                  finalMessage: "last words",
                },
              };
            }
            if (harness === "timeout") {
              return {
                result: "failed",
                data: { reason: "wall", message: "the harness ran longer than 600s" },
              };
            }
            return {
              result: "failed",
              data: {
                reason: "exit",
                modelError: { kind: "unavailable", status: 503, retry_after_secs: null },
                message: "unavailable",
              },
            };
          }
          if (mode === "exit-no-write") {
            return {
              result: "failed",
              data: { reason: "exit", message: "the harness exited 1", finalMessage: "no file tool" },
            };
          }
          if (mode === "swap-review") {
            const folder = dirname(input.resultPath);
            const outside = mkdtempSync(join(tmpdir(), "operad-swap-"));
            writeFileSync(
              join(outside, basename(input.resultPath)),
              JSON.stringify({ findings: [], verified: ["outside"] }),
            );
            rmSync(folder, { recursive: true, force: true });
            symlinkSync(outside, folder);
            return { result: "done", data: {} };
          }
          if (mode === "no-write") {
            return {
              result: "done",
              data: { finalMessage: "I cannot create files there" },
            };
          }
          if (mode === "invalid-then-nothing") {
            if (count === 1) {
              writeFileSync(input.resultPath, "this is not JSON\n");
            }
            return { result: "done", data: {} };
          }
          if (mode === "fifo") {
            fifos.push(input.resultPath);
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
          if (mode.startsWith("file:")) {
            // The findings come from a file, so a test can change them per round.
            writeFileSync(
              input.resultPath,
              JSON.stringify({
                findings: JSON.parse(readFileSync(mode.slice(5), "utf8")),
                verified: ["the diff"],
              }),
            );
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
                      severity: "major",
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
  readonly commands?: readonly CheckCommand[];
  readonly commandTimeoutSecs?: number;
  readonly rerun?: number;
  readonly reviewerArgs?: readonly string[];
  readonly firstArgs?: readonly string[];
  readonly reviewerStallSecs?: number;
  readonly reviewerTimeoutSecs?: number;
  readonly fixLevel?: FixLevel;
  readonly maxAutoRework?: number;
  readonly maxFileDiffBytes?: number;
  readonly maxDiffBytes?: number;
  /** Make the fake reviewer write an invalid report on every round's first call. */
  readonly retryInvalid?: boolean;
  /** The optional second reviewer the fallback setting names. */
  readonly fallback?: {
    readonly use: string;
    readonly args: readonly string[];
  };
  /** How long an unavailable review waits before it runs again. */
  readonly retrySecs?: number;
  /** A file the fake reviewer appends one line to per call. */
  readonly callLog?: string;
  /** Add one small committed file after the worktree is created. */
  readonly commit?: boolean;
  readonly clock?: ManualClock;
  /** Files already on main when the task's worktree is made. */
  readonly baseFiles?: Readonly<Record<string, string>>;
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
  const root = await osTempRoot();
  const remote = await makeRemote(root);
  for (const [file, text] of Object.entries(options.baseFiles ?? {})) {
    await advanceMain(remote, file, text, `add ${file}`);
  }
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
        ...(options.rerun === undefined ? {} : { check: { rerun: options.rerun } }),
        reviewer: {
          use: "fake-reviewer/agent",
          args: options.reviewerArgs ?? ["none"],
          ...(options.firstArgs === undefined
            ? {}
            : { firstArgs: options.firstArgs }),
          ...(options.fallback === undefined
            ? {}
            : { fallback: options.fallback }),
          ...(options.reviewerTimeoutSecs === undefined
            ? {}
            : { timeoutSecs: options.reviewerTimeoutSecs }),
          ...(options.reviewerStallSecs === undefined
            ? {}
            : { stallSecs: options.reviewerStallSecs }),
          fixLevel: options.fixLevel ?? "major",
          retrySecs: options.retrySecs ?? 120,
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
    ...(options.callLog === undefined ? {} : { callLog: options.callLog }),
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

function reviewDue(state: Fixture, runId = "review-due") {
  return state.registry.runStep("dev/review_due", {}, {
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

  test("a verify with no branch still records the review phase", async () => {
    const state = await fixture();
    // Remove the work branch so `branchHead` finds nothing: verify fails before
    // any gate command runs and must not fall back to `running`.
    gitOrThrow(state.remote.repository, [
      "update-ref",
      "-d",
      `refs/heads/${workBranch(state.taskId)}`,
    ]);
    const result = await verify(state);
    expect(result.result).toBe("fail");
    expect(String(result.data?.message)).toContain("no branch");
    expect((await taskOf(state)).phase).toBe("review");
  });

  test("a check that fails once and then passes is a pass with a note", async () => {
    const root = await tempRoot();
    const marker = join(root, "seen");
    const state = await fixture({
      commands: [`if [ -f '${marker}' ]; then echo second; else touch '${marker}'; echo first; exit 1; fi`],
    });
    const result = await verify(state);
    expect(result.result).toBe("pass");
    expect(result.data?.note).toBe("check line 1 failed, passed on rerun");
    const task = await taskOf(state);
    expect(task.attempt?.verify?.result).toBe("pass");
    expect(task.brief).toContain("] check line 1 failed, passed on rerun");
    const log = readFileSync(String(result.data?.log), "utf8");
    expect(log).toContain("first");
    expect(log).toContain("check failed; running it once more");
    expect(log).toContain("second");
    expect(log.indexOf("first")).toBeLessThan(log.indexOf("second"));
  });

  test("a check that fails twice is a fail", async () => {
    const root = await tempRoot();
    const count = join(root, "count");
    const state = await fixture({ commands: [`echo x >> '${count}'; exit 1`] });
    const result = await verify(state);
    expect(result.result).toBe("fail");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
    expect((await taskOf(state)).brief).not.toContain("passed on rerun");
  });

  test("rerun 0 fails at once", async () => {
    const root = await tempRoot();
    const count = join(root, "count");
    const state = await fixture({ rerun: 0, commands: [`echo x >> '${count}'; exit 1`] });
    const result = await verify(state);
    expect(result.result).toBe("fail");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a timeout is not rerun", async () => {
    const clock = manualClock();
    const root = await tempRoot();
    const marker = join(root, "started");
    const count = join(root, "count");
    const state = await fixture({
      clock,
      commands: [`echo x >> '${count}'; trap '' TERM; echo $$ > '${marker}'; sleep 30`],
      commandTimeoutSecs: 5,
    });
    const running = verify(state);
    await waitForFile(marker);
    expect(clock.fireTimeouts()).toBe(1);
    const result = await running;
    expect(result.result).toBe("fail");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
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

  describe("review.json", () => {
    function grading(state: Fixture, content: string): void {
      mkdirSync(join(state.remote.repository, ".operad"), { recursive: true });
      writeFileSync(join(state.remote.repository, ".operad", "review.json"), content);
    }

    test("the prompt carries the flow's grading verbatim", async () => {
      const state = await fixture({ reviewerArgs: ["none"] });
      grading(
        state,
        JSON.stringify({
          default: { levels: { minor: "default minor" } },
          flows: {
            dev: {
              levels: { critical: "C <b>text</b>", major: "M text" },
              rules: ["Rule one.", "Rule two."],
            },
            other: { levels: { critical: "NOT THIS" } },
          },
        }),
      );
      await verify(state);
      await review(state);
      const prompt = state.reviewer.calls[0]?.prompt ?? "";
      expect(prompt).toContain(
        [
          "## Grading",
          "- critical: C <b>text</b>\n- major: M text\n- minor: default minor\n- Rule one.\n- Rule two.",
        ].join("\n\n"),
      );
      expect(prompt).not.toContain("NOT THIS");
    });

    test("no file means no grading section", async () => {
      const state = await fixture({ reviewerArgs: ["none"] });
      await verify(state);
      await review(state);
      expect(state.reviewer.calls[0]?.prompt).not.toContain("## Grading");
    });

    test("fixLevel in review.json decides whether a minor finding fails", async () => {
      const state = await fixture({ reviewerArgs: ["minor"], fixLevel: "major" });
      grading(state, JSON.stringify({ flows: { dev: { fixLevel: "minor" } } }));
      await verify(state);
      const result = await review(state);
      expect(result.result).toBe("fail");
      expect(result.data?.counted).toBe(1);
    });

    test("fixLevel in review.json can also be higher than dev.json's", async () => {
      const state = await fixture({ reviewerArgs: ["major"], fixLevel: "minor" });
      grading(state, JSON.stringify({ default: { fixLevel: "critical" } }));
      await verify(state);
      const result = await review(state);
      expect(result.result).toBe("pass");
    });

    test("an invalid file fails the review step naming the file", async () => {
      const state = await fixture({ reviewerArgs: ["none"] });
      grading(state, JSON.stringify({ default: { fixLevel: "huge" } }));
      await verify(state);
      let message = "";
      try {
        await review(state);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("review.json");
      expect(message).toContain("default.fixLevel");
      expect(state.reviewer.calls).toHaveLength(0);
    });
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

  test("the FIFO the previous test made is gone, and it was made outside the repository", () => {
    expect(fifos.length).toBeGreaterThan(0);
    for (const path of fifos) {
      expect(existsSync(path)).toBe(false);
      expect(path.startsWith(process.cwd())).toBe(false);
    }
  });

  test("a finding on a file the change did not touch is pre-existing and does not count", async () => {
    const state = await fixture({
      reviewerArgs: ["pre-existing"],
      fixLevel: "major",
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

  test("reviewer.stallSecs reaches the harness step, and is absent when unset", async () => {
    const set = await fixture({ reviewerStallSecs: 900 });
    await verify(set);
    await review(set, "review-stall-1");
    expect(set.reviewer.calls[0]?.stallSecs).toBe(900);

    const unset = await fixture();
    await verify(unset);
    await review(unset, "review-stall-2");
    expect(unset.reviewer.calls[0]?.stallSecs).toBeUndefined();
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

  describe("renames and deletions", () => {
    const numbered = (count: number, edit?: number): string =>
      `${Array.from({ length: count }, (_, index) =>
        index + 1 === edit ? `edited line ${index + 1}` : `source line ${index + 1}`,
      ).join("\n")}\n`;
    const commitAll = (worktree: string, message: string): void => {
      gitOrThrow(worktree, ["add", "-A"]);
      gitOrThrow(worktree, [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        message,
      ]);
    };

    test("a rename with no edit is one line", async () => {
      const state = await fixture({
        baseFiles: { "old.txt": numbered(5000) },
        maxFileDiffBytes: 200_000,
        maxDiffBytes: 20_000,
        commit: false,
      });
      gitOrThrow(state.worktree, ["mv", "old.txt", "new.txt"]);
      commitAll(state.worktree, "rename");
      await verify(state);
      const result = await review(state);
      expect(result.result).toBe("pass");
      const prompt = state.reviewer.calls[0]?.prompt ?? "";
      expect(prompt).toContain("renamed old.txt → new.txt, unchanged");
      expect(prompt).not.toContain("source line 2500");
      expect(prompt.length).toBeLessThan(10_000);
    });

    test("a rename with an edit carries only the edit", async () => {
      const state = await fixture({
        baseFiles: { "old.txt": numbered(5000) },
        maxFileDiffBytes: 200_000,
        maxDiffBytes: 20_000,
        commit: false,
      });
      gitOrThrow(state.worktree, ["mv", "old.txt", "new.txt"]);
      writeFileSync(join(state.worktree, "new.txt"), numbered(5000, 2500));
      commitAll(state.worktree, "rename and edit");
      await verify(state);
      const result = await review(state);
      expect(result.result).toBe("pass");
      const prompt = state.reviewer.calls[0]?.prompt ?? "";
      expect(prompt).toContain("rename from old.txt");
      expect(prompt).toContain("+edited line 2500");
      expect(prompt).toContain("-source line 2500");
      expect(prompt).not.toContain("source line 100\n");
      expect(prompt.length).toBeLessThan(10_000);
    });

    test("a deleted file is one line with its length and how to read it", async () => {
      const state = await fixture({
        baseFiles: { "gone.txt": numbered(5000) },
        maxFileDiffBytes: 200_000,
        maxDiffBytes: 20_000,
        commit: false,
      });
      gitOrThrow(state.worktree, ["rm", "-q", "gone.txt"]);
      commitAll(state.worktree, "delete");
      await verify(state);
      const result = await review(state);
      expect(result.result).toBe("pass");
      const prompt = state.reviewer.calls[0]?.prompt ?? "";
      expect(prompt).toContain("gone.txt: deleted, 5000 lines");
      expect(prompt).toContain("git show");
      expect(prompt).not.toContain("source line 2500");
      expect(prompt.length).toBeLessThan(10_000);
    });
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

describe("dev/review fallback and retry", () => {
  test("a 429 falls back once, and the round passes without a rework", async () => {
    const state = await fixture({
      reviewerArgs: ["429-once", "--model", "primary"],
      fallback: {
        use: "fake-reviewer/agent",
        args: ["none", "--model", "fallback"],
      },
    });
    await verify(state);
    const result = await review(state, "review-fallback");
    expect(result.result).toBe("pass");
    expect(result.data?.model).toBe("fallback");
    // The history line reads its why from this message.
    expect(String(result.data?.message)).toContain("primary was unavailable");
    expect(String(result.data?.message)).toContain("fallback reviewed");
    expect(state.reviewer.calls.map((call) => call.args)).toEqual([
      ["429-once", "--model", "primary"],
      ["none", "--model", "fallback"],
    ]);

    const task = await taskOf(state);
    expect(task.attempt?.reviews).toBe(1);
    expect(task.attempt?.review?.decision).toBe("passed");
    expect(task.attempt?.review?.result).toBe("passed");
    expect(task.attempt?.review?.model).toBe("fallback");
    expect(task.attempt?.review?.runs?.map((run) => run.role)).toEqual([
      "primary",
      "fallback",
    ]);
    expect(task.attempt?.review?.runs?.[0]?.outcome).toBe("unavailable");
    expect(task.attempt?.review?.runs?.[1]?.outcome).toBe("report");
    expect(task.reworkStreak).toBe(0);
    expect(task.phase).toBe("waiting");
  });

  test("no fallback and a 429 wait for retrySecs, then run the review only", async () => {
    const state = await fixture({
      reviewerArgs: ["429-once", "--model", "primary"],
      retrySecs: 120,
    });
    await verify(state);
    let clock = 10_000;
    reviewTestHooks.now = () => clock;
    try {
      const first = await review(state, "review-wait");
      expect(first.result).toBe("unavailable");
      expect(first.data?.retryAt).toBe(130_000);
      expect(state.reviewer.calls).toHaveLength(1);

      let task = await taskOf(state);
      expect(task.phase).toBe("waiting");
      expect(task.attempt?.review?.decision).toBe("unavailable");
      expect(task.attempt?.review?.retryAt).toBe(130_000);
      expect(task.retryAt).toBe(130_000);
      expect(task.attempt?.reviews).toBe(0);
      expect(task.reworkStreak).toBeUndefined();

      // Before the clock moves the step asks no model again.
      clock = 129_999;
      const early = await review(state, "review-wait");
      expect(early.result).toBe("unavailable");
      expect(state.reviewer.calls).toHaveLength(1);

      // The wait lets the flow continue at the recorded time.
      clock = 130_000;
      const due = await state.registry.runStep("dev/review_due", {}, {
        runId: "review-wait",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(due.result).toBe("ready");

      const second = await review(state, "review-wait");
      expect(second.result).toBe("pass");
      expect(state.reviewer.calls).toHaveLength(2);
      task = await taskOf(state);
      expect(task.attempt?.review?.decision).toBe("passed");
      expect(task.attempt?.reviews).toBe(1);
      expect(task.attempt?.number).toBe(1);
      expect(task.attempt?.review?.runs?.[1]?.reason).toBe("retry");
      expect(task.reworkStreak).toBe(0);
      expect(task.retryAt ?? null).toBeNull();
    } finally {
      delete reviewTestHooks.now;
    }
  });

  test("a fallback that is also unavailable waits without a rework", async () => {
    const state = await fixture({
      reviewerArgs: ["unavailable", "--model", "primary"],
      fallback: {
        use: "fake-reviewer/agent",
        args: ["unavailable", "--model", "fallback"],
      },
      retrySecs: 30,
    });
    await verify(state);
    let clock = 5_000;
    reviewTestHooks.now = () => clock;
    let result: PluginStepResult;
    try {
      result = await review(state, "review-both-unavailable");
    } finally {
      delete reviewTestHooks.now;
    }
    expect(result.result).toBe("unavailable");
    expect(state.reviewer.calls).toHaveLength(2);
    const task = await taskOf(state);
    expect(task.attempt?.review?.decision).toBe("unavailable");
    expect(task.attempt?.review?.retryAt).toBe(35_000);
    expect(task.retryAt).toBe(35_000);
    expect(task.attempt?.review?.runs?.map((run) => run.outcome)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    expect(task.attempt?.reviews).toBe(0);
    expect(task.reworkStreak).toBeUndefined();
  });

  test("a retry after the wait does not use the fallback a second time", async () => {
    const state = await fixture({
      reviewerArgs: ["unavailable", "--model", "primary"],
      fallback: {
        use: "fake-reviewer/agent",
        args: ["unavailable", "--model", "fallback"],
      },
      retrySecs: 30,
    });
    await verify(state);
    let clock = 5_000;
    reviewTestHooks.now = () => clock;
    try {
      const first = await review(state, "review-fallback-once");
      expect(first.result).toBe("unavailable");
      expect(state.reviewer.calls).toHaveLength(2);

      // The recorded retry time has come, so the same round starts again.
      clock = 35_000;
      const second = await review(state, "review-fallback-once");
      expect(second.result).toBe("unavailable");
      // The primary ran again; the round's one fallback was already used.
      expect(state.reviewer.calls.map((call) => call.args)).toEqual([
        ["unavailable", "--model", "primary"],
        ["unavailable", "--model", "fallback"],
        ["unavailable", "--model", "primary"],
      ]);
      const task = await taskOf(state);
      expect(task.attempt?.review?.runs?.map((run) => run.role)).toEqual([
        "primary",
        "fallback",
        "primary",
      ]);
      expect(task.attempt?.reviews).toBe(0);
      expect(task.attempt?.review?.retryAt).toBe(65_000);
    } finally {
      delete reviewTestHooks.now;
    }
  });

  test("a retry longer than the step timeout waits in pieces and reruns only when due", async () => {
    const state = await fixture({
      reviewerArgs: ["429-once", "--model", "primary"],
      retrySecs: 4 * 60 * 60,
    });
    await verify(state);
    let clock = 5_000;
    const waits: number[] = [];
    reviewTestHooks.now = () => clock;
    reviewTestHooks.wait = async (ms) => {
      waits.push(ms);
      clock += ms;
      return true;
    };
    try {
      const first = await review(state, "review-long-wait");
      expect(first.result).toBe("unavailable");
      const retryAt = first.data?.retryAt as number;
      expect(retryAt).toBe(5_000 + 4 * 60 * 60 * 1000);

      let due = await reviewDue(state, "review-long-wait");
      expect(due.result).toBe("ready");
      // One run asks for less than its step timeout, so the wait survives.
      expect(waits[0]).toBe(REVIEW_WAIT_CHUNK_MS);
      expect(waits[0]).toBeLessThan(STEP_TIMEOUT_SECS * 1000);
      expect(due.data?.at as number).toBeLessThan(retryAt);

      while ((due.data?.at as number) < retryAt) {
        // The early piece ends in a replayed round, never a model call.
        const replayed = await review(state, "review-long-wait");
        expect(replayed.result).toBe("unavailable");
        expect(state.reviewer.calls).toHaveLength(1);
        due = await reviewDue(state, "review-long-wait");
      }
      expect(due.data?.at).toBe(retryAt);

      const retried = await review(state, "review-long-wait");
      expect(retried.result).toBe("pass");
      expect(state.reviewer.calls).toHaveLength(2);
      expect((await taskOf(state)).attempt?.number).toBe(1);
    } finally {
      delete reviewTestHooks.now;
      delete reviewTestHooks.wait;
    }
  });

  test("a timeout runs once more with the same arguments and then succeeds", async () => {
    const state = await fixture({
      reviewerArgs: ["timeout-once", "--model", "primary"],
    });
    await verify(state);
    const result = await review(state, "review-timeout-once");
    expect(result.result).toBe("pass");
    expect(String(result.data?.message)).toContain("timed out");
    expect(state.reviewer.calls.map((call) => call.args)).toEqual([
      ["timeout-once", "--model", "primary"],
      ["timeout-once", "--model", "primary"],
    ]);
    const task = await taskOf(state);
    expect(task.attempt?.review?.decision).toBe("passed");
    expect(task.attempt?.review?.runs?.map((run) => run.outcome)).toEqual([
      "timed_out",
      "report",
    ]);
    expect(task.attempt?.review?.runs?.[1]?.reason).toBe("retry");
  });

  test("a second timeout waits for a person with the note", async () => {
    const state = await fixture({
      reviewerArgs: ["timeout", "--model", "primary"],
    });
    await verify(state);
    const result = await review(state, "review-timeout-twice");
    expect(result.result).toBe("timed_out");
    expect(result.data?.message).toBe("review timed out twice");
    expect(state.reviewer.calls).toHaveLength(2);
    const task = await taskOf(state);
    expect(task.phase).toBe("waiting");
    expect(task.attempt?.review?.decision).toBe("timed_out");
    expect(task.attempt?.review?.message).toBe("review timed out twice");
    expect(task.attempt?.reviews).toBe(1);
    expect(task.reworkStreak).toBeUndefined();
  });
  test("a new attempt starts a fresh review round", async () => {
    const state = await fixture({
      reviewerArgs: ["unavailable", "--model", "primary"],
    });
    await verify(state);
    const first = await review(state, "review-attempt-1");
    expect(first.result).toBe("unavailable");
    expect(state.reviewer.calls).toHaveLength(1);

    const prepared = await state.registry.runStep("dev/worktree", {}, {
      runId: "worktree-2",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(prepared.result).toBe("ready");
    await verify(state, "verify-2");
    const second = await review(state, "review-attempt-2");
    expect(second.result).toBe("unavailable");
    expect(state.reviewer.calls).toHaveLength(2);
    const task = await taskOf(state);
    expect(task.attempt?.number).toBe(2);
    expect(task.attempt?.reviews).toBe(0);
    expect(task.attempt?.reviewRuns).toHaveLength(1);
    expect(task.attempt?.reviewRuns?.[0]?.attempt).toBe(2);
  }, 30_000);
});

/**
 * The real radian harness plugin. The dev package does not depend on it, so
 * the test loads it by path instead of adding a package dependency for one test.
 */
async function loadRadianHarness(): Promise<ReturnType<typeof definePlugin>> {
  const path = fileURLToPath(
    new URL("../../harness-radian/src/index.ts", import.meta.url),
  );
  const loaded: unknown = await import(path);
  const make =
    typeof loaded === "object" && loaded !== null && "createRadianHarnessPlugin" in loaded
      ? loaded.createRadianHarnessPlugin
      : undefined;
  if (typeof make !== "function") throw new Error("no radian harness plugin");
  return make() as ReturnType<typeof definePlugin>;
}

describe("dev/review hardening", () => {
  test("a 429 only in a stderr line or a number is not unavailable", async () => {
    const state = await fixture({
      reviewerArgs: ["not-429"],
      fallback: { use: "fake-reviewer/agent", args: ["none"] },
    });
    await verify(state);
    const result = await review(state, "review-not-429");
    expect(result.result).toBe("failed");
    // No fallback was tried: the failure is not an unavailable model. A run
    // that failed without a report is tried once more, like a missing report.
    expect(state.reviewer.calls).toHaveLength(2);
    expect(
      (await taskOf(state)).attempt?.review?.runs?.map((run) => run.role),
    ).toEqual(["primary", "primary"]);
  }, 30_000);

  test("a usage limit reported as a model error falls back", async () => {
    const state = await fixture({
      reviewerArgs: ["usage-limit", "--model", "primary"],
      fallback: { use: "fake-reviewer/agent", args: ["none"] },
    });
    await verify(state);
    const result = await review(state, "review-usage-limit");
    expect(result.result).toBe("pass");
    expect(state.reviewer.calls).toHaveLength(2);
  }, 30_000);

  for (const mode of ["report-then-exit", "report-then-wall"]) {
    test(`a valid report from a reviewer that then failed (${mode}) is used and kept`, async () => {
      const state = await fixture({ reviewerArgs: [mode] });
      await verify(state);
      const result = await review(state, `review-${mode}`);
      expect(result.result).toBe("pass");
      expect(state.reviewer.calls).toHaveLength(1);
      const path = state.reviewer.calls[0]?.resultPath ?? "";
      expect(existsSync(path)).toBe(true);
      const task = await taskOf(state);
      expect(task.attempt?.review?.runs?.[0]?.outcome).toBe("report");
    });
  }

  test("a radian Result with a model_error makes the real harness report unavailable", async () => {
    const state = await fixture({
      reviewerArgs: [],
      fallback: { use: "fake-reviewer/agent", args: ["none", "--model", "fallback"] },
    });
    // Point the reviewer at the real radian harness, run against a fake radian.
    const bin = join(state.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "radian"),
      [
        "#!/bin/sh",
        `echo '{"type":"Result","session_id":"s","outcome":"failed","exit_code":1,"stop_reason":"failed","usage":{},"cost":null,"text":"","model_error":{"kind":"unavailable","status":429,"retry_after_secs":30}}'`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "radian"), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    const path = join(state.remote.repository, ".operad", "dev.json");
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      reviewer: Record<string, unknown>;
    };
    settings.reviewer.use = "harness-radian/agent";
    writeFileSync(path, JSON.stringify(settings));
    const registry = new PluginRegistry(
      [
        createDevPlugin(),
        createShellPlugin(),
        await loadRadianHarness(),
        state.reviewer.plugin,
      ],
      { home: state.root, cwd: state.remote.repository, store: state.store },
    );
    try {
      await verify(state);
      const result = await registry.runStep("dev/review", {}, {
        runId: "review-radian",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(result.result).toBe("pass");
      expect(state.reviewer.calls).toHaveLength(1);
      const task = await taskOf(state);
      expect(task.attempt?.review?.runs?.map((run) => run.outcome)).toEqual([
        "unavailable",
        "report",
      ]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  test("reverify starts review round 1 again and asks the reviewer", async () => {
    const state = await fixture({ reviewerArgs: ["major"], maxAutoRework: 5 });
    await verify(state);
    const first = await review(state, "review-reverify");
    expect(first.result).toBe("fail");
    expect(state.reviewer.calls).toHaveLength(1);

    await setTaskPhase(state.store, state.taskKey, "waiting");
    const registry = new PluginRegistry([createDevPlugin()], {
      home: state.root,
      cwd: state.remote.repository,
      store: state.store,
      onAnswer: async () => {},
    });
    await registry.runAction("dev/reverify", {}, {
      object: await state.store.get("task", state.taskKey) as never,
      runId: "review-reverify",
      actor: { via: "test", id: "lead" },
    });
    const cleared = await taskOf(state);
    expect(cleared.attempt?.reviewRuns).toEqual([]);
    expect(cleared.attempt?.reviewPending).toBeNull();

    await verify(state, "verify-again");
    const second = await review(state, "review-reverify");
    expect(second.result).toBe("fail");
    expect(second.data?.replayed).toBeUndefined();
    expect(state.reviewer.calls).toHaveLength(2);
    const task = await taskOf(state);
    expect(task.attempt?.review?.runs).toHaveLength(1);
  });

  test("an unavailable model waits at most MAX_REVIEW_WAITS times, across a restart", async () => {
    const state = await fixture({
      reviewerArgs: ["unavailable", "--model", "primary"],
      retrySecs: 120,
    });
    await verify(state);
    let clock = 1_000_000;
    reviewTestHooks.now = () => clock;
    try {
      let registry = state.registry;
      for (let wait = 1; wait <= MAX_REVIEW_WAITS; wait += 1) {
        if (wait === 20) {
          // A restart: a new registry reads the count from the task's facts.
          registry = new PluginRegistry(
            [createDevPlugin(), createShellPlugin(), state.reviewer.plugin],
            { home: state.root, cwd: state.remote.repository, store: state.store },
          );
        }
        const result = await registry.runStep("dev/review", {}, {
          runId: "review-exhaust",
          object: { type: "task", id: state.taskKey, data: {} },
        });
        expect(result.result).toBe("unavailable");
        clock += 120_000;
      }
      expect(state.reviewer.calls).toHaveLength(MAX_REVIEW_WAITS);
      const last = await registry.runStep("dev/review", {}, {
        runId: "review-exhaust",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(last.result).toBe("exhausted");
      expect(String(last.data?.message)).toContain(
        "review did not finish (model unavailable)",
      );
      expect(state.reviewer.calls).toHaveLength(MAX_REVIEW_WAITS + 1);
      const task = await taskOf(state);
      expect(task.phase).toBe("waiting");
      expect(task.retryAt ?? null).toBeNull();
      expect(task.reworkStreak ?? 0).toBe(0);

      // A replay of the stopped round reads it back and asks no model.
      const replay = await registry.runStep("dev/review", {}, {
        runId: "review-exhaust",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(replay.result).toBe("exhausted");
      expect(state.reviewer.calls).toHaveLength(MAX_REVIEW_WAITS + 1);
    } finally {
      delete reviewTestHooks.now;
    }
  }, 60_000);

  test("runs that cannot fit in the step deadline are skipped and a person decides", async () => {
    const state = await fixture({
      reviewerArgs: ["unavailable", "--model", "primary"],
      reviewerTimeoutSecs: 3600,
      fallback: {
        use: "fake-reviewer/agent",
        args: ["timeout", "--model", "fallback"],
      },
    });
    await verify(state);
    let clock = 1_000_000;
    reviewTestHooks.now = () => clock;
    // Each run uses its whole hour.
    reviewTestHooks.afterCall = () => {
      clock += 3_600_000;
    };
    try {
      const result = await review(state, "review-out-of-time");
      expect(result.result).toBe("out_of_time");
      // primary (unavailable), fallback (timed out); the retry would pass 3 h.
      expect(state.reviewer.calls).toHaveLength(2);
      expect(String(result.data?.message)).toContain(
        "review did not finish (out of time)",
      );
      const task = await taskOf(state);
      expect(task.phase).toBe("waiting");
      expect(task.attempt?.reviews).toBe(1);
      expect(task.reworkStreak ?? 0).toBe(0);
    } finally {
      delete reviewTestHooks.now;
      delete reviewTestHooks.afterCall;
    }
  });
});

describe("dev/review crash recovery", () => {
  interface CrashCase {
    readonly crash:
      | "after-first-result"
      | "during-fallback"
      | "after-first-saved"
      | "before-copy";
    readonly reviewerArgs: readonly string[];
    readonly fallback?: {
      readonly use: string;
      readonly args: readonly string[];
    };
    /** Model calls the resumed process makes. */
    readonly resumedCalls: number;
    /** The arguments of those calls, in order. */
    readonly resumedArgs?: (readonly string[])[];
    /** Lines the call log holds after both processes. */
    readonly totalCalls: number;
    /** The roles of the runs the resumed round records. */
    readonly roles: ("primary" | "fallback")[];
  }

  async function crashReview(options: CrashCase) {
    const callLog = join(await tempRoot(), "review-calls");
    const state = await fixture({
      reviewerArgs: options.reviewerArgs,
      ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
      callLog,
    });
    await verify(state);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        REVIEW_CRASH_CHILD,
        state.store.root,
        state.remote.repository,
        state.taskKey,
        "review-crash",
        options.crash,
        callLog,
      ],
      // Not the repository: it lives under the temp directory, and bun reads
      // every entry of each directory above its working directory while it
      // starts. A temp directory with a million entries (a machine where other
      // programs leave theirs there) made the child take 5 to 10 s to start,
      // and three gates at once pushed the test past 30 s. The child gets the
      // repository as an argument and gives it to the registry itself.
      cwd: dirname(REVIEW_CRASH_CHILD),
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");

    // The parent opens the store again and runs the same round in a new
    // process, as serve would after a crash.
    const store = new FilePluginStore({ root: state.store.root });
    const reviewer = fakeReviewer({ callLog });
    const registry = new PluginRegistry([createDevPlugin(), reviewer.plugin], {
      home: state.root,
      cwd: state.remote.repository,
      store,
    });
    const resumed = await registry.runStep("dev/review", {}, {
      runId: "review-crash",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(resumed.result).toBe("pass");
    expect(reviewer.calls).toHaveLength(options.resumedCalls);
    if (options.resumedArgs !== undefined) {
      expect(reviewer.calls.map((call) => call.args)).toEqual(
        options.resumedArgs,
      );
    }
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toHaveLength(
      options.totalCalls,
    );

    const object = await store.get("task", state.taskKey);
    if (object === undefined) throw new Error("task disappeared");
    const task = taskData(object.data);
    expect(task.attempt?.number).toBe(1);
    expect(task.attempt?.reviews).toBe(1);
    expect(task.attempt?.review?.decision).toBe("passed");
    expect(task.attempt?.reviewPending ?? null).toBeNull();
    expect(task.attempt?.review?.runs?.map((run) => run.role)).toEqual(
      options.roles,
    );
  }

  test("a crash after the first result reuses it instead of asking again", async () => {
    await crashReview({
      crash: "after-first-result",
      reviewerArgs: ["none", "--model", "primary"],
      resumedCalls: 0,
      totalCalls: 1,
      roles: ["primary"],
    });
  });

  test("a crash after an unavailable first result resumes on the fallback", async () => {
    await crashReview({
      crash: "after-first-result",
      reviewerArgs: ["unavailable", "--model", "primary"],
      fallback: {
        use: "fake-reviewer/agent",
        args: ["none", "--model", "fallback"],
      },
      resumedCalls: 1,
      resumedArgs: [["none", "--model", "fallback"]],
      totalCalls: 2,
      roles: ["primary", "fallback"],
    });
  });

  test("a crash during the fallback reads its result back", async () => {
    await crashReview({
      crash: "during-fallback",
      reviewerArgs: ["unavailable", "--model", "primary"],
      fallback: {
        use: "fake-reviewer/agent",
        args: ["none", "--model", "fallback"],
      },
      resumedCalls: 0,
      totalCalls: 2,
      roles: ["primary", "fallback"],
    });
  });

  test("a crash after the first run was saved resumes on the fallback", async () => {
    await crashReview({
      crash: "after-first-saved",
      reviewerArgs: ["unavailable", "--model", "primary"],
      fallback: {
        use: "fake-reviewer/agent",
        args: ["none", "--model", "fallback"],
      },
      resumedCalls: 1,
      resumedArgs: [["none", "--model", "fallback"]],
      totalCalls: 2,
      roles: ["primary", "fallback"],
    });
  });
});

describe("dev/review crash before the store copy", () => {
  test("a crash after the report was written and before its copy resumes by copying it", async () => {
    const callLog = join(await tempRoot(), "review-calls");
    const state = await fixture({ reviewerArgs: ["none"], callLog });
    await verify(state);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        REVIEW_CRASH_CHILD,
        state.store.root,
        state.remote.repository,
        state.taskKey,
        "review-crash",
        "before-copy",
        callLog,
      ],
      cwd: dirname(REVIEW_CRASH_CHILD),
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const stored = join(
      state.store.root,
      "dev",
      "reviews",
      "review-crash",
      `${state.taskId}-attempt-1-review-1.json`,
    );
    expect(existsSync(stored)).toBe(false);

    const store = new FilePluginStore({ root: state.store.root });
    const reviewer = fakeReviewer({ callLog });
    const registry = new PluginRegistry([createDevPlugin(), reviewer.plugin], {
      home: state.root,
      cwd: state.remote.repository,
      store,
    });
    const resumed = await registry.runStep("dev/review", {}, {
      runId: "review-crash",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(resumed.result).toBe("pass");
    expect(reviewer.calls).toHaveLength(0);
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(readFileSync(stored, "utf8"))).toEqual({
      findings: [],
      verified: ["the diff"],
    });
  });
});

describe("dev/review report in the workspace", () => {
  async function gatePathOf(state: Fixture): Promise<string> {
    const settings: DevSettings = await readDevSettings(state.remote.repository);
    return gateWorktreePath(state.remote.repository, settings, state.taskId);
  }

  test("a reviewer that can only write inside its cwd passes, and dev keeps the store copy", async () => {
    const state = await fixture({ reviewerArgs: ["none"] });
    await verify(state);
    const gate = await gatePathOf(state);
    const result = await review(state);
    expect(result.result).toBe("pass");
    const path = state.reviewer.calls[0]?.resultPath ?? "";
    expect(path.startsWith(join(gate, ".operad", "review") + "/")).toBe(true);
    expect(path).toContain("review-run-attempt-1-review-1-try-0.json");
    expect(state.reviewer.calls[0]?.prompt).toContain(path);
    const stored = join(
      state.store.root,
      "dev",
      "reviews",
      "review-run",
      `${state.taskId}-attempt-1-review-1.json`,
    );
    expect(readFileSync(stored, "utf8")).toBe(readFileSync(path, "utf8"));
    // Dev never deletes the workspace report.
    expect(existsSync(path)).toBe(true);
  });

  test("tracked and untracked files under .operad/review survive a review with a retry", async () => {
    const state = await fixture({
      reviewerArgs: ["invalid-then-valid"],
      commit: false,
    });
    mkdirSync(join(state.worktree, ".operad", "review"), { recursive: true });
    await commitIn(state.worktree, "code.txt", "line\n", "add code");
    await commitIn(
      state.worktree,
      join(".operad", "review", "x.json"),
      "tracked bytes\n",
      "track a report-shaped file",
    );
    await verify(state);
    const gate = await gatePathOf(state);
    reviewTestHooks.beforeRun = () => {
      writeFileSync(join(gate, ".operad", "review", "y.json"), "untracked bytes\n");
    };
    try {
      const result = await review(state);
      expect(result.result).toBe("pass");
    } finally {
      delete reviewTestHooks.beforeRun;
    }
    expect(state.reviewer.calls).toHaveLength(2);
    expect(readFileSync(join(gate, ".operad", "review", "x.json"), "utf8")).toBe(
      "tracked bytes\n",
    );
    expect(readFileSync(join(gate, ".operad", "review", "y.json"), "utf8")).toBe(
      "untracked bytes\n",
    );
  });

  for (const shape of ["operad", "review", "report"] as const) {
    test(`a symlinked ${shape} is not followed and the review fails with the reason`, async () => {
      const state = await fixture({ reviewerArgs: ["none"] });
      await verify(state);
      const gate = await gatePathOf(state);
      const outside = mkdtempSync(join(tmpdir(), "operad-outside-"));
      const target = shape === "report" ? join(outside, "file.json") : outside;
      if (shape === "report") writeFileSync(target, "outside\n");
      reviewTestHooks.beforeRun = () => {
        rmSync(join(gate, ".operad"), { recursive: true, force: true });
        if (shape === "operad") {
          symlinkSync(outside, join(gate, ".operad"));
          return;
        }
        mkdirSync(join(gate, ".operad"));
        if (shape === "review") {
          symlinkSync(outside, join(gate, ".operad", "review"));
          return;
        }
        mkdirSync(join(gate, ".operad", "review"));
        symlinkSync(
          target,
          join(
            gate,
            ".operad",
            "review",
            "review-run-attempt-1-review-1-try-0.json",
          ),
        );
      };
      try {
        const result = await review(state);
        expect(result.result).toBe("failed");
        const message = String(result.data?.message);
        if (shape === "report") {
          expect(message).toContain("review-run-attempt-1-review-1-try-0.json");
          expect(readFileSync(target, "utf8")).toBe("outside\n");
        } else {
          expect(message).toContain(join(gate, ".operad"));
          expect(message).toContain("not a plain directory");
        }
        expect(state.reviewer.calls).toHaveLength(0);
        if (shape !== "report") {
          expect(Bun.spawnSync({ cmd: ["ls", "-A", outside] }).stdout.toString()).toBe("");
        }
        expect(lstatSync(join(gate, ".operad")).isSymbolicLink() || shape !== "operad").toBe(true);
      } finally {
        delete reviewTestHooks.beforeRun;
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }

  test("a retry after an invalid report uses a new path and never reads the old file", async () => {
    const state = await fixture({ reviewerArgs: ["invalid-then-nothing"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    const [first, second] = state.reviewer.calls;
    expect(first?.resultPath).toContain("-try-0.json");
    expect(second?.resultPath).toContain("-try-1.json");
    // The old invalid file is still there, untouched, and was not read: the
    // second call is a missing file, not another invalid one.
    expect(readFileSync(first?.resultPath ?? "", "utf8")).toBe("this is not JSON\n");
    const task = await taskOf(state);
    expect(task.attempt?.review?.runs?.map((run) => run.outcome)).toEqual([
      "invalid",
      "no_report",
    ]);
  });

  test("a failed store write fails the step and leaves the workspace report", async () => {
    const state = await fixture({ reviewerArgs: ["none"] });
    await verify(state);
    const stored = join(
      state.store.root,
      "dev",
      "reviews",
      "review-run",
      `${state.taskId}-attempt-1-review-1.json`,
    );
    reviewTestHooks.beforeRun = () => {
      mkdirSync(stored, { recursive: true });
    };
    try {
      const result = await review(state);
      expect(result.result).toBe("failed");
      expect(String(result.data?.message)).toContain("cannot write the review record");
      expect(state.reviewer.calls).toHaveLength(1);
      expect(existsSync(state.reviewer.calls[0]?.resultPath ?? "")).toBe(true);
    } finally {
      delete reviewTestHooks.beforeRun;
    }
  });

  test("a missing report and an invalid report have different labels", async () => {
    const missing = await fixture({ reviewerArgs: ["no-write"] });
    await verify(missing);
    const none = await review(missing);
    expect(none.result).toBe("failed");
    const noneMessage = String(none.data?.message);
    expect(noneMessage).toContain("could not write the report");
    expect(noneMessage).toContain("I cannot create files there");
    expect(noneMessage).not.toContain("invalid report");
    expect(missing.reviewer.calls).toHaveLength(2);

    const invalid = await fixture({ reviewerArgs: ["invalid"] });
    await verify(invalid);
    const bad = await review(invalid);
    expect(String(bad.data?.message)).toContain("wrote an invalid report");
    expect(String(bad.data?.message)).not.toContain("could not write");
  });

  test("a folder swapped for a link while the report is read is not accepted", async () => {
    const state = await fixture({ reviewerArgs: ["none"] });
    await verify(state);
    const gate = await gatePathOf(state);
    const folder = join(gate, ".operad", "review");
    const outside = mkdtempSync(join(tmpdir(), "operad-race-"));
    let swapped = false;
    reviewTestHooks.afterOpen = () => {
      if (swapped) return;
      swapped = true;
      const name = readdirSync(folder)[0] ?? "";
      writeFileSync(
        join(outside, name),
        JSON.stringify({ findings: [], verified: ["outside"] }),
      );
      rmSync(folder, { recursive: true, force: true });
      symlinkSync(outside, folder);
    };
    try {
      const result = await review(state);
      expect(result.result).toBe("failed");
      const stored = join(
        state.store.root,
        "dev",
        "reviews",
        "review-run",
        `${state.taskId}-attempt-1-review-1.json`,
      );
      expect(existsSync(stored)).toBe(false);
    } finally {
      delete reviewTestHooks.afterOpen;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  const TABLE: readonly (readonly [string, string, ReviewRunOutcome])[] = [
    ["done", "valid", "report"],
    ["failed", "valid", "report"],
    ["timeout", "valid", "report"],
    ["unavailable", "valid", "report"],
    ["done", "invalid", "invalid"],
    ["failed", "invalid", "invalid"],
    ["timeout", "invalid", "invalid"],
    ["unavailable", "invalid", "invalid"],
    ["done", "none", "no_report"],
    ["failed", "none", "no_report"],
    ["timeout", "none", "timed_out"],
    ["unavailable", "none", "unavailable"],
  ];
  for (const [harness, file, expected] of TABLE) {
    test(`harness ${harness} with ${file} file is ${expected}`, async () => {
      const state = await fixture({ reviewerArgs: [`table:${harness}:${file}`] });
      await verify(state);
      const result = await review(state);
      const task = await taskOf(state);
      expect(task.attempt?.review?.runs?.[0]?.outcome).toBe(expected);
      if (expected === "no_report") {
        expect(String(result.data?.message)).toContain("could not write the report");
      }
      if (expected === "invalid") {
        expect(String(result.data?.message)).toContain("wrote an invalid report");
      }
    });
  }

  test("a reviewer that exits without a report is labelled as unable to write it", async () => {
    const state = await fixture({ reviewerArgs: ["exit-no-write"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    const message = String(result.data?.message);
    expect(message).toContain("could not write the report");
    expect(message).toContain("no file tool");
    expect(state.reviewer.calls).toHaveLength(2);
    const task = await taskOf(state);
    expect(task.attempt?.review?.runs?.map((run) => run.outcome)).toEqual([
      "no_report",
      "no_report",
    ]);
  });

  test("a report found through a link swapped in after a crash is not read", async () => {
    const callLog = join(await tempRoot(), "review-calls");
    const state = await fixture({ reviewerArgs: ["none"], callLog });
    await verify(state);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        REVIEW_CRASH_CHILD,
        state.store.root,
        state.remote.repository,
        state.taskKey,
        "review-crash",
        "before-copy",
        callLog,
      ],
      cwd: dirname(REVIEW_CRASH_CHILD),
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    const gate = await gatePathOf(state);
    const folder = join(gate, ".operad", "review");
    const name = readdirSync(folder)[0] ?? "";
    const outside = mkdtempSync(join(tmpdir(), "operad-after-crash-"));
    writeFileSync(
      join(outside, name),
      JSON.stringify({ findings: [], verified: ["outside"] }),
    );
    rmSync(folder, { recursive: true, force: true });
    symlinkSync(outside, folder);
    const stored = join(
      state.store.root,
      "dev",
      "reviews",
      "review-crash",
      `${state.taskId}-attempt-1-review-1.json`,
    );
    try {
      const store = new FilePluginStore({ root: state.store.root });
      const reviewer = fakeReviewer({ callLog });
      const registry = new PluginRegistry([createDevPlugin(), reviewer.plugin], {
        home: state.root,
        cwd: state.remote.repository,
        store,
      });
      await registry.runStep("dev/review", {}, {
        runId: "review-crash",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(existsSync(stored) ? readFileSync(stored, "utf8") : "").not.toContain("outside");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a review folder swapped for a link during the call is not read through", async () => {
    const state = await fixture({ reviewerArgs: ["swap-review"] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain("not a plain directory");
  });

  test("a report at the store path from an older prompt is read when the workspace has none", async () => {
    const state = await fixture({ reviewerArgs: ["none"] });
    await verify(state);
    const task = await taskOf(state);
    const gate = await gatePathOf(state);
    const stored = join(
      state.store.root,
      "dev",
      "reviews",
      "review-run",
      `${state.taskId}-attempt-1-review-1.json`,
    );
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(stored, JSON.stringify({ findings: [], verified: ["old"] }));
    await state.store.put("task", state.taskKey, {
      ...task,
      attempt: {
        ...(task.attempt ?? { number: 1, run: "review-run" }),
        reviewPending: {
          attempt: 1,
          round: 1,
          role: "primary",
          use: "fake-reviewer/agent",
          args: ["none"],
          model: "fake-reviewer/agent",
          reason: "initial",
          run: "review-run",
        },
      },
    }, "test:pending");
    expect(gate.length).toBeGreaterThan(0);
    const result = await review(state);
    expect(result.result).toBe("pass");
    expect(state.reviewer.calls).toHaveLength(0);
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
    expect(task.brief).toContain("] rework 1 — verify: the verify command failed: false");
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
    expect(task.brief).toContain(
      "] rework 1 — review: code.txt:2 major: a real problem — when called",
    );
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
      retrySecs: 120,
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
    expect(() => validateDevSettings({ reviewer: { fixLevel: "high" } })).toThrow(
      /reviewer\.fixLevel/,
    );
    expect(() => validateDevSettings({ reviewer: { retrySecs: 0 } })).toThrow(
      /reviewer\.retrySecs/,
    );
    expect(() =>
      validateDevSettings({ reviewer: { fallback: { args: [] } } }),
    ).toThrow(/reviewer\.fallback\.use/);
    expect(() =>
      validateDevSettings({ reviewer: { fallback: { use: "x/agent", other: 1 } } }),
    ).toThrow(/reviewer\.fallback\.other/);
    expect(
      validateDevSettings({ reviewer: { fallback: { use: "x/agent" } } })
        .reviewer.fallback,
    ).toEqual({ use: "x/agent", args: [] });
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
    expect(nextOf("worktree")).toEqual({
      ready: "work",
      conflict: "work",
      blocked: "announce_blocked",
      failed: "end_failed",
      cancelled: "end_cancelled",
      interrupted: "announce_worktree_stopped",
    });
    expect(nextOf("work")).toEqual({
      done: "verify",
      nothing: "announce_nothing",
      failed: "announce_work_failed",
      unavailable: "work_retry",
      cancelled: "end_cancelled",
      interrupted: "announce_work_stopped",
    });
    expect(nextOf("work_retry")).toEqual({
      ready: "work",
      interrupted: "end_cancelled",
    });
    expect(nextOf("verify")).toEqual({
      pass: "review",
      fail: "rework",
      cancelled: "end_cancelled",
    });
    expect(nextOf("review")).toEqual({
      pass: "announce_ready",
      fail: "rework",
      failed: "announce_review_failed",
      unavailable: "review_retry",
      timed_out: "wait_review_timeout",
      exhausted: "wait_review_unavailable",
      out_of_time: "wait_review_out_of_time",
      cancelled: "end_cancelled",
    });
    for (const id of ["wait_review_unavailable", "wait_review_out_of_time"]) {
      expect(nextOf(id)).toEqual({
        merge: "integrate",
        reject: "worktree",
        rework: "worktree",
        interrupted: "end_cancelled",
      });
    }
    // The flow's visit bound is finite and equals the one the waits are sized by.
    expect(found?.flow.maxVisits).toBe(DEV_MAX_VISITS);
    expect(nextOf("review_retry")).toEqual({
      ready: "review",
      interrupted: "end_cancelled",
    });
    expect(nextOf("wait_review_timeout")).toEqual({
      merge: "integrate",
      reject: "worktree",
      rework: "worktree",
      interrupted: "end_cancelled",
    });
    expect(nextOf("rework")).toEqual({
      again: "worktree",
      ask: "announce_rework",
      cancelled: "end_cancelled",
    });
    expect(nextOf("wait")).toEqual({
      merge: "integrate",
      reject: "worktree",
      rework: "worktree",
      reverify: "reverify",
      interrupted: "end_cancelled",
    });
    expect(nextOf("integrate")).toEqual({
      merged: "cleanup",
      conflict: "worktree",
      fail: "worktree",
      failed: "announce_integrate",
      cancelled: "end_cancelled",
    });
    // Every stop that needs a person passes an announce step first.
    for (const step of steps) {
      if (!step.id.startsWith("announce_")) continue;
      expect(nextOf(step.id)).toEqual({
        done: "wait",
        interrupted: "wait",
        cancelled: "end_cancelled",
      });
    }
    expect(nextOf("cleanup")).toEqual({
      done: "end_done",
      cancelled: "end_cancelled",
    });
  });

  test("a review wait longer than ten pieces keeps waiting", async () => {
    const root = await tempRoot();
    const remote = await makeRemote(root);
    const store = storeAt(root);
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: remote.repository,
      store,
    });
    const found = registry.flow("dev");
    if (found === undefined) throw new Error("the dev flow is missing");
    const flow = found.flow;

    // Start in the retry wait, as the flow is after an unavailable review.
    let state: KernelState = {
      ...initialState(),
      status: "running",
      started: true,
      step: "review_retry",
      stepKind: "wait",
      effect: {
        id: "review_retry:1",
        kind: "poll_check",
        step: "review_retry",
        use: null,
        params: null,
        check: "dev/review_due",
        due: null,
        replay: "safe",
      },
      effectStarted: "review_retry:1",
      visits: { review_retry: 1 },
      effects: { "review_retry:1": "outstanding" },
      lastSeq: 100,
    };

    const apply = (result: string): void => {
      const effectId = state.effect?.id;
      if (effectId === undefined) {
        throw new Error("the flow is not waiting for a step result");
      }
      const decision = decide(
        flow,
        state,
        { kind: "step_result", effectId, result },
        0,
      );
      expect(
        decision.facts.some((fact) => fact.kind === "visit_limit_reached"),
      ).toBe(false);
      state = decision.facts.reduce(evolve, state);
    };

    // Each piece is one review entry and one retry-wait entry. The engine
    // default of ten visits would end the task during the fifth piece.
    for (let piece = 0; piece < 20; piece += 1) {
      apply("ready");
      expect(state.status).toBe("running");
      expect(state.step).toBe("review");
      apply("unavailable");
      // A wait step parks the run until its check is answered again.
      expect(state.status).toBe("waiting");
      expect(state.step).toBe("review_retry");
    }
    expect(state.visits.review).toBe(20);
    expect(state.visits.review_retry).toBe(21);
  });
});

describe("dev/verify reruns only the failed tests", () => {
  const MATCH = "^\\(fail\\) (.+?) \\[[0-9.]+m?s\\]$";
  const failing = (...names: string[]): string =>
    `${names.map((name) => `echo ${JSON.stringify(`(fail) ${name} [1.00ms]`)} >&2`).join("; ")}; exit 1`;
  const object = (
    run: string,
    rerun: string,
    max?: number,
  ): CheckCommand => ({
    run,
    failed: { match: MATCH, rerun, max: max ?? 10 },
  });

  test("a failed test that passes alone passes the check, is reported and counted", async () => {
    const root = await tempRoot();
    const ran = join(root, "ran");
    const state = await fixture({
      commands: [
        object(
          failing("process groups > the sentinel", "other suite > b"),
          `printf '%s\\n' {name} >> '${ran}'`,
        ),
      ],
    });
    const result = await verify(state);
    expect(result.result).toBe("pass");
    expect(readFileSync(ran, "utf8")).toBe(
      "process groups > the sentinel\nother suite > b\n",
    );
    const note =
      "passed on rerun: process groups > the sentinel; other suite > b";
    expect(result.data?.note).toBe(note);
    expect((await taskOf(state)).brief).toContain(`] ${note}`);
    const log = readFileSync(String(result.data?.log), "utf8");
    expect(log).toContain("(fail) process groups > the sentinel [1.00ms]");
    expect(log).toContain("===== rerun of failed test: process groups > the sentinel =====");
    expect(log.indexOf("(fail) other")).toBeLessThan(log.indexOf("rerun of failed test: process"));
    expect(await listRerunCounts(state.store)).toEqual([
      { name: "other suite > b", count: 1 },
      { name: "process groups > the sentinel", count: 1 },
    ]);
  });

  test("a test that reaches check.flakyTask with no confirmed plan puts a notice in the step's history", async () => {
    const root = await tempRoot();
    const state = await fixture({
      commands: [object(failing("a > flaky"), `echo {name} >> '${join(root, "ran")}'`)],
    });
    const first = await verify(state);
    expect(String(first.data?.note)).not.toContain("no task was proposed");
    const second = await verify(state, "verify-run-2");
    const notice = `flaky test "a > flaky" passed on rerun 2 times; no task was proposed: no confirmed plan that is not finished`;
    expect(second.data?.reason).toBe(notice);
    expect(String(second.data?.note)).toContain(notice);
    expect((await taskOf(state)).brief).toContain(notice);
  });

  test("a rerun that fails fails the check", async () => {
    const root = await tempRoot();
    const ran = join(root, "ran");
    const state = await fixture({
      commands: [
        object(
          failing("a > one", "a > two"),
          `echo {name} >> '${ran}'; case {name} in *two) exit 1;; esac`,
        ),
      ],
    });
    const result = await verify(state);
    expect(result.result).toBe("fail");
    expect(String(result.data?.message)).toContain('"a > two" failed again');
    expect((await taskOf(state)).brief).not.toContain("passed on rerun");
    // The test that passed is still counted.
    expect(await listRerunCounts(state.store)).toEqual([{ name: "a > one", count: 1 }]);
  });

  test("no name found fails without a rerun", async () => {
    const root = await tempRoot();
    const ran = join(root, "ran");
    const state = await fixture({
      commands: [object("echo compile error >&2; exit 1", `echo {name} >> '${ran}'`)],
    });
    expect((await verify(state)).result).toBe("fail");
    expect(existsSync(ran)).toBe(false);
  });

  test("more names than max fails without a rerun", async () => {
    const root = await tempRoot();
    const ran = join(root, "ran");
    const state = await fixture({
      commands: [object(failing("a", "b", "c"), `echo {name} >> '${ran}'`, 2)],
    });
    expect((await verify(state)).result).toBe("fail");
    expect(existsSync(ran)).toBe(false);
  });

  test("a timeout is not rerun", async () => {
    const clock = manualClock();
    const root = await tempRoot();
    const marker = join(root, "started");
    const ran = join(root, "ran");
    const state = await fixture({
      clock,
      commands: [
        object(
          `echo '(fail) t [1ms]' >&2; trap '' TERM; echo $$ > '${marker}'; sleep 30`,
          `echo {name} >> '${ran}'`,
        ),
      ],
      commandTimeoutSecs: 5,
    });
    const running = verify(state);
    await waitForFile(marker);
    expect(clock.fireTimeouts()).toBe(1);
    expect((await running).result).toBe("fail");
    expect(existsSync(ran)).toBe(false);
  });

  test("the whole-command rerun is not used when failed is declared", async () => {
    const root = await tempRoot();
    const count = join(root, "count");
    const state = await fixture({
      commands: [object(`echo x >> '${count}'; exit 1`, "true {name}")],
    });
    expect((await verify(state)).result).toBe("fail");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("plain strings around an object command keep their meaning and line numbers", async () => {
    const root = await tempRoot();
    const ran = join(root, "ran");
    const state = await fixture({
      commands: [
        "true",
        object(failing("x > y"), `echo {name} >> '${ran}'`),
        "echo last; exit 3",
      ],
    });
    const result = await verify(state);
    expect(result.result).toBe("fail");
    expect(result.data?.lineNumber).toBe(3);
    expect(readFileSync(ran, "utf8")).toBe("x > y\n");
  });

  test("names with quotes and regex characters reach the rerun intact", async () => {
    const root = await tempRoot();
    const names = join(root, "names");
    const patterns = join(root, "patterns");
    const name = `suite > it's "quoted" $(touch ${root}/pwned) [a.b]* \`x\``;
    writeFileSync(join(root, "out"), `(fail) ${name} [1.00ms]\n`);
    const state = await fixture({
      commands: [
        object(
          `cat '${join(root, "out")}' >&2; exit 1`,
          `printf '%s' {name} > '${names}'; printf '%s' {pattern} > '${patterns}'`,
        ),
      ],
    });
    expect((await verify(state)).result).toBe("pass");
    expect(readFileSync(names, "utf8")).toBe(name);
    expect(existsSync(join(root, "pwned"))).toBe(false);
    const pattern = readFileSync(patterns, "utf8");
    expect(pattern).toBe(anchoredPattern(name));
    expect(new RegExp(pattern).test(name.replace(" > ", " "))).toBe(true);
  });

  test("the pattern is anchored and joins describe names with a space, as bun test -t does", () => {
    expect(anchoredPattern("a > b (c)")).toBe("^a b \\(c\\)$");
    expect(rerunCommand("bun test -t {pattern}", "it's")).toBe("bun test -t '^it'\\''s$'");
    expect(rerunCommand("run {name} {name}", "$x")).toBe("run '$x' '$x'");
  });

  test("the count accumulates across tasks", async () => {
    const store = storeAt(await osTempRoot());
    await recordRerunPasses(store, ["a", "b"]);
    await recordRerunPasses(store, ["b"]);
    await recordRerunPasses(store, ["b", "c"]);
    expect(await listRerunCounts(store)).toEqual([
      { name: "b", count: 3 },
      { name: "a", count: 1 },
      { name: "c", count: 1 },
    ]);
  });
});

describe("dev/review rework rounds", () => {
  const lines = (count: number, tag = "line") =>
    Array.from({ length: count }, (_, index) => `${tag} ${index + 1}\n`).join("");

  interface Round {
    readonly state: Fixture;
    readonly findingsFile: string;
    readonly first: Awaited<ReturnType<typeof review>>;
    readonly firstSha: string;
  }

  function writeFindings(path: string, findings: readonly unknown[]): void {
    writeFileSync(path, JSON.stringify(findings));
  }

  function finding(file: string, line: number, severity = "major") {
    return { file, line, severity, summary: `${severity} at ${file}:${line}`, trigger: "t" };
  }

  /** A task whose first review ran and reported `first`. */
  async function afterFirstReview(first: readonly unknown[]): Promise<Round> {
    const dir = await tempRoot();
    const findingsFile = join(dir, "findings.json");
    writeFindings(findingsFile, first);
    const state = await fixture({
      reviewerArgs: [`file:${findingsFile}`],
      commit: false,
      baseFiles: { "code.txt": lines(40) },
    });
    await commitIn(
      state.worktree,
      "code.txt",
      lines(40)
        .replace("line 5\n", "changed 5\n")
        .replace("line 30\n", "changed 30\n"),
      "first change",
    );
    const verified = await verify(state, "verify-1");
    const firstResult = await review(state, "review-1");
    return {
      state,
      findingsFile,
      first: firstResult,
      firstSha: verified.data?.verified as string,
    };
  }

  /** Starts the next attempt, as a rework does. */
  async function nextAttempt(state: Fixture): Promise<void> {
    const object = await state.store.get("task", state.taskKey);
    if (object === undefined) throw new Error("task disappeared");
    const task = taskData(object.data);
    await state.store.put(
      "task",
      state.taskKey,
      {
        ...task,
        attempts: 2,
        attempt: { number: 2, run: "rework-run", worktree: task.attempt?.worktree },
      },
      "test:attempt",
    );
  }

  async function secondReview(round: Round, change: () => Promise<void>) {
    await nextAttempt(round.state);
    await change();
    await verify(round.state, "verify-2");
    return review(round.state, "review-2");
  }

  test("the first review gets the whole diff; a rework round gets the previous findings and the increment", async () => {
    const round = await afterFirstReview([finding("code.txt", 5)]);
    expect(round.first.result).toBe("fail");
    const firstPrompt = round.state.reviewer.calls[0]?.prompt ?? "";
    expect(firstPrompt).toContain("## Diff");
    expect(firstPrompt).not.toContain("## Previous review");
    writeFindings(round.findingsFile, []);
    const second = await secondReview(round, async () => {
      await commitIn(
        round.state.worktree,
        "code.txt",
        lines(40)
          .replace("line 5\n", "changed 5\n")
          .replace("line 30\n", "again 30\n"),
        "fix",
      );
    });
    expect(second.result).toBe("pass");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    const sections = prompt.split("\n").filter((line) => line.startsWith("## "));
    expect(sections).toEqual([
      "## Brief",
      "## Previous review",
      "## Commits since the previous review",
      "## Increment",
      "## What to write",
    ]);
    expect(prompt).not.toContain("## Diff");
    expect(prompt).toContain(`looked at ${round.firstSha}`);
    expect(prompt).toContain("- [major] code.txt:5 major at code.txt:5");
    expect(prompt).toContain("fix");
    expect(prompt).toContain("+again 30");
    expect(prompt).not.toContain("+changed 5");
    expect(prompt).toContain("whether it is fixed or not fixed");
    expect(second.data?.message).toContain(
      "rework round: 1 previous findings, 1 fixed, 0 moved as pre-existing",
    );
    const changes = splitBrief((await taskOf(round.state)).brief).changes;
    expect(changes).toContain(
      "rework round: 1 previous findings, 1 fixed, 0 moved as pre-existing",
    );
    expect(changes.split("rework round:").length).toBe(2);
  });

  test("a review of the same commit as the previous review gets the first prompt", async () => {
    const round = await afterFirstReview([finding("code.txt", 5)]);
    await review(round.state, "review-again");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    expect(prompt).toContain("## Diff");
    expect(prompt).not.toContain("## Previous review");
    const result = await review(round.state, "review-third");
    expect(result.data?.reworkRound).toBeUndefined();
  });

  test("lines that came only with a merge of main are not in the increment", async () => {
    const round = await afterFirstReview([]);
    await advanceMain(round.state.remote, "main.txt", "from main\n", "main moves");
    const second = await secondReview(round, async () => {
      gitOrThrow(round.state.worktree, ["fetch", "origin"]);
      gitOrThrow(round.state.worktree, [
        "-c", "user.name=t", "-c", "user.email=t@example.com",
        "merge", "--no-ff", "--no-edit", "origin/main",
      ]);
      await commitIn(round.state.worktree, "mine.txt", "mine\n", "mine");
    });
    expect(second.result).toBe("pass");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    expect(prompt).toContain("+mine");
    expect(prompt).not.toContain("from main");
    expect(prompt).not.toContain("main.txt");
  });

  test("a rework round keeps an unfixed finding near the previous one and moves a far one with its level", async () => {
    const round = await afterFirstReview([finding("code.txt", 5)]);
    writeFindings(round.findingsFile, [
      finding("code.txt", 12), // 7 lines from the changed line 5, 7 from the previous finding
      finding("code.txt", 20), // far from both
    ]);
    const second = await secondReview(round, async () => {
      await commitIn(round.state.worktree, "extra.txt", "x\n", "more");
    });
    expect(second.result).toBe("fail");
    expect(second.data?.counted).toBe(1);
    expect(second.data?.moved).toBe(1);
    const found = second.data?.findings as readonly {
      readonly line: number;
      readonly severity: string;
      readonly pre_existing?: boolean;
    }[];
    expect(found[0]?.pre_existing).toBeUndefined();
    expect(found[1]).toMatchObject({ line: 20, severity: "major", pre_existing: true });
    expect(second.data?.message).toContain(
      "rework round: 1 previous findings, 0 fixed, 1 moved as pre-existing",
    );
  });

  test("a far critical finding still fails; a far major one in an untouched file is moved", async () => {
    const dir = await tempRoot();
    const findingsFile = join(dir, "findings.json");
    writeFindings(findingsFile, [
      finding("base.txt", 50, "critical"),
      finding("base.txt", 60, "major"),
    ]);
    const state = await fixture({
      reviewerArgs: [`file:${findingsFile}`],
      baseFiles: { "base.txt": lines(100) },
    });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("fail");
    expect(result.data?.counted).toBe(1);
    expect(result.data?.moved).toBe(1);
    const found = result.data?.findings as readonly {
      readonly severity: string;
      readonly pre_existing?: boolean;
    }[];
    expect(found[0]?.pre_existing).toBeUndefined();
    expect(found[1]).toMatchObject({ severity: "major", pre_existing: true });
  });

  test("a previous sha that is not a commit in the checkout makes a first review", async () => {
    const round = await afterFirstReview([finding("code.txt", 5)]);
    const key = round.state.taskKey;
    const object = await round.state.store.get("task", key);
    if (object === undefined) throw new Error("task disappeared");
    const task = taskData(object.data);
    await round.state.store.put("task", key, {
      ...task,
      reviewHistory: (task.reviewHistory ?? []).map((entry) => ({
        ...entry,
        sha: "0123456789abcdef0123456789abcdef01234567",
      })),
    }, "test:history");
    await nextAttempt(round.state);
    await commitIn(round.state.worktree, "code.txt", lines(41), "more");
    await verify(round.state, "verify-2");
    await review(round.state, "review-2");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    expect(prompt).toContain("## Diff");
    expect(prompt).not.toContain("## Previous review");
  });

  test("a model's own pre_existing mark is ignored", async () => {
    const dir = await tempRoot();
    const findingsFile = join(dir, "findings.json");
    writeFindings(findingsFile, [{ ...finding("code.txt", 1), pre_existing: true }]);
    const state = await fixture({ reviewerArgs: [`file:${findingsFile}`] });
    await verify(state);
    const result = await review(state);
    expect(result.result).toBe("fail");
    expect(result.data?.counted).toBe(1);
  });

  test("a rework round resumed after a crash asks with the prompt it recorded", async () => {
    const round = await afterFirstReview([finding("code.txt", 5)]);
    await nextAttempt(round.state);
    await commitIn(round.state.worktree, "code.txt", lines(41), "fix");
    await verify(round.state, "verify-2");
    const callLog = join(await tempRoot(), "calls");
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        REVIEW_CRASH_CHILD,
        round.state.store.root,
        round.state.remote.repository,
        round.state.taskKey,
        "review-crash",
        "before-run",
        callLog,
      ],
      cwd: dirname(REVIEW_CRASH_CHILD),
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const promptFile = join(
      round.state.store.root,
      "dev",
      "reviews",
      "review-crash",
      `${round.state.taskId}-attempt-2-review-1.prompt.md`,
    );
    const recorded = readFileSync(promptFile, "utf8");
    expect(recorded).toContain("## Previous review");
    writeFileSync(promptFile, `${recorded}\nRECORDED-MARK\n`);
    const store = new FilePluginStore({ root: round.state.store.root });
    const reviewer = fakeReviewer({});
    const registry = new PluginRegistry([createDevPlugin(), reviewer.plugin], {
      home: round.state.root,
      cwd: round.state.remote.repository,
      store,
    });
    await registry.runStep("dev/review", {}, {
      runId: "review-crash",
      object: { type: "task", id: round.state.taskKey, data: {} },
    });
    expect(reviewer.calls).toHaveLength(1);
    expect(reviewer.calls[0]?.prompt).toContain("RECORDED-MARK");
    expect(reviewer.calls[0]?.prompt).toContain("## Previous review");
  });

  test("a review later in the same attempt is a first review", async () => {
    const round = await afterFirstReview([]);
    await advanceMain(round.state.remote, "main.txt", "from main\n", "main moves");
    gitOrThrow(round.state.worktree, ["fetch", "origin"]);
    gitOrThrow(round.state.worktree, [
      "-c", "user.name=t", "-c", "user.email=t@example.com",
      "merge", "--no-ff", "--no-edit", "origin/main",
    ]);
    await verify(round.state, "verify-2");
    await review(round.state, "review-2");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    expect(prompt).toContain("## Diff");
    expect(prompt).not.toContain("## Previous review");
  });

  test("a rework that only deletes a line keeps its hunk in the increment", async () => {
    const round = await afterFirstReview([]);
    writeFindings(round.findingsFile, []);
    const second = await secondReview(round, async () => {
      await commitIn(
        round.state.worktree,
        "code.txt",
        lines(40)
          .replace("line 5\n", "changed 5\n")
          .replace("line 30\n", "changed 30\n")
          .replace("line 31\n", ""),
        "delete",
      );
    });
    expect(second.result).toBe("pass");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    expect(prompt).toContain("-line 31");
    expect(prompt).not.toContain("No line of the task's own change was changed");
  });

  test("a reverify of the same commit demotes nothing", async () => {
    // Line 20 is far from the changes at lines 5 and 30: a first review moves it.
    const round = await afterFirstReview([finding("code.txt", 20)]);
    expect(round.first.result).toBe("pass");
    expect(round.first.data?.moved).toBe(1);
    const again = await review(round.state, "review-again");
    expect(again.result).toBe("fail");
    expect(again.data?.counted).toBe(1);
    expect(again.data?.moved).toBe(0);
  });

  test("the increment reads context lines, so a deletion beside the task's change keeps its hunk", async () => {
    const round = await afterFirstReview([]);
    const second = await secondReview(round, async () => {
      await commitIn(
        round.state.worktree,
        "code.txt",
        lines(40)
          .replace("line 5\n", "changed 5\n")
          .replace("line 30\n", "changed 30\n")
          .replace("line 7\n", ""),
        "delete next to a change",
      );
    });
    expect(second.result).toBe("pass");
    const prompt = round.state.reviewer.calls[1]?.prompt ?? "";
    expect(prompt).toContain("+changed 5");
    expect(prompt).not.toContain("No line of the task's own change was changed");
  });

  test("a same-attempt review of a new commit still moves a far finding", async () => {
    const round = await afterFirstReview([]);
    writeFindings(round.findingsFile, [finding("code.txt", 20)]);
    await advanceMain(round.state.remote, "main.txt", "from main\n", "main moves");
    gitOrThrow(round.state.worktree, ["fetch", "origin"]);
    gitOrThrow(round.state.worktree, [
      "-c", "user.name=t", "-c", "user.email=t@example.com",
      "merge", "--no-ff", "--no-edit", "origin/main",
    ]);
    await verify(round.state, "verify-2");
    const again = await review(round.state, "review-2");
    expect(again.result).toBe("pass");
    expect(again.data?.moved).toBe(1);
  });
});
