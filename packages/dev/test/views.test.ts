import { afterAll, describe, expect, test } from "bun:test";
import {
  addPlan,
  addRepository,
  addRework,
  addTask,
  getPlan,
  getTask,
  setTaskPhase,
} from "../src/service.ts";
import { FilePluginStore } from "@operad-io/engine";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIFF_PAGE_CHARS,
  ROW_WORKER_CHARS,
  metrics,
  planViews,
  readableLog,
  readableLogLine,
  taskViews,
  tokenCount,
} from "../src/views.ts";
import { planNote } from "../src/model.ts";
import { commitIn, gitOrThrow, makeRemote } from "./git-support.ts";
import { bareId, planData, taskData } from "../src/model.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

async function setup() {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath });
  const plan = await addPlan(store, {
    repository,
    slug: "storage",
    title: "Storage",
    request: "# Request\n\nWrite the store.",
  });
  const task = await addTask(store, {
    plan: plan.id,
    slug: "jsonl",
    title: "JSONL",
    brief: "# Brief\n\nUse lines.",
  });
  return { store, plan, task };
}

describe("dev views", () => {
  test("a radian Result line shows its stop reason, tokens and cost", () => {
    const line = JSON.stringify({ type: "Result", stop_reason: "end_turn", usage: { input: 5, output: 6 }, cost: { micros: 12346 } });
    expect(readableLog([line])).toEqual(["result: end_turn · 5 in / 6 out tokens · $0.0123"]);
  });

  test("a radian Result line with text keeps the assistant text and the metadata", () => {
    const line = JSON.stringify({ type: "Result", text: "All done.\nBye", stop_reason: "end_turn", usage: { input: 5, output: 6 } });
    expect(readableLog([line])).toEqual(["**agent:** All done. Bye", "result: end_turn · 5 in / 6 out tokens"]);
  });

  test("a radian Result text is cut at 300 characters", () => {
    const line = JSON.stringify({ type: "Result", text: "x".repeat(400), stop_reason: "end_turn" });
    const out = readableLog([line]);
    expect(out[0]).toBe(`**agent:** ${"x".repeat(299)}…`);
  });

  test("a plan row shows the derived state and merged/total", async () => {
    const { store, plan, task } = await setup();
    const confirmed = await getPlan(store, plan.id);
    expect(planViews.row(confirmed)).toEqual({
      id: "P-0001-storage",
      title: "Storage",
      state: "draft",
      note: "0/1 · off · P3 // 1",
      scope: "repository",
      final: false,
      mark: "proposed",
      parent: "repo:repository",
    });
    await setTaskPhase(store, task.id, "merged");
    expect(planViews.row(await getPlan(store, plan.id)).note).toBe(
      "1/1 · off · P3 // 1",
    );
    // A confirmed plan whose tasks are all merged is finished, which is final;
    // a cancelled plan is final too.
    const done = await getPlan(store, plan.id);
    await store.put(
      "plan",
      plan.id,
      { ...planData(done.data), status: "confirmed" },
      "test:finish",
    );
    const finished = planViews.row(await getPlan(store, plan.id));
    expect(finished.state).toBe("finished");
    expect(finished.final).toBe(true);
    await store.put(
      "plan",
      plan.id,
      { ...planData(done.data), status: "cancelled" },
      "test:cancel",
    );
    expect(planViews.row(await getPlan(store, plan.id)).final).toBe(true);
  });

  test("a task row carries the tasks it waits for, and none when it waits for none", async () => {
    const { store, plan, task } = await setup();
    expect("after" in taskViews.row(await getTask(store, task.id))).toBe(false);
    const second = await addTask(store, {
      plan: plan.id,
      slug: "second",
      title: "Second",
      brief: "# Brief\n\nx",
      after: [bareId(task.id)],
    });
    expect(taskViews.row(await getTask(store, second.id)).after).toEqual([bareId(task.id)]);
  });

  test("a task row reads the phase and the cost", async () => {
    const { store, task } = await setup();
    const stored = await getTask(store, task.id);
    expect(taskViews.row(stored)).toEqual({
      id: "T-0001-jsonl",
      title: "JSONL",
      state: "proposed",
      note: "$0.00",
      scope: "repository",
      final: false,
      mark: "proposed",
      waiting: true,
      badge: "#0",
      parent: "plan:repository/P-0001-storage",
    });
    for (const phase of ["merged", "cancelled"] as const) {
      await setTaskPhase(store, task.id, phase);
      expect(taskViews.row(await getTask(store, task.id)).final).toBe(true);
    }
    await setTaskPhase(store, task.id, "review");
    expect(taskViews.row(await getTask(store, task.id)).final).toBe(false);
    await store.put(
      "task",
      task.id,
      { ...taskData(stored.data), cost: 0.31 },
      "test:cost",
    );
    expect(taskViews.row(await getTask(store, task.id))).toMatchObject({
      note: "$0.31",
    });
    for (const quality of ["estimated", "incomplete"] as const) {
      await store.put(
        "task",
        task.id,
        { ...taskData(stored.data), cost: 0.31, costQuality: quality },
        "test:cost",
      );
      expect(taskViews.row(await getTask(store, task.id))).toMatchObject({
        note: quality === "estimated" ? "~$0.31" : "≥$0.31",
      });
    }
  });

  test("a task has brief and changes, and rework only after it has some", async () => {
    const { store, task } = await setup();
    const before = await getTask(store, task.id);
    expect(planViews.sections(before)).toEqual([
      { id: "request", title: "Request" },
    ]);
    expect(taskViews.sections(before).map((section) => section.id)).toEqual([
      "brief",
      "changes",
      "log",
      "diff",
      "metrics",
    ]);
    expect(await taskViews.load({} as never, before, "brief", {})).toEqual({
      markdown: "# Brief\n\nUse lines.",
    });
    expect(
      ((await taskViews.load({} as never, before, "changes", {})) as {
        markdown: string;
      }).markdown,
    ).toMatch(/- \d\d:\d\d {2}created/);

    await addRework(store, task.id, "review", "Add a test.");
    const after = await getTask(store, task.id);
    expect(taskViews.sections(after).map((section) => section.id)).toEqual([
      "brief",
      "rework",
      "changes",
      "log",
      "diff",
      "metrics",
    ]);
    const rework = (await taskViews.load({} as never, after, "rework", {})) as {
      markdown: string;
    };
    expect(rework.markdown).toContain("## Rework 1 (review)");
    expect(rework.markdown).not.toContain("## Changes");
  });

  test("a plan loads its request and has no tasks section", async () => {
    const { store, plan } = await setup();
    const stored = await getPlan(store, plan.id);
    expect(await planViews.load({ store } as never, stored, "request", {})).toEqual({
      markdown: "# Request\n\nWrite the store.",
    });
    expect(planViews.sections(stored).map((section) => section.id)).not.toContain("tasks");
    expect(await planViews.load({ store } as never, stored, "tasks", {})).toEqual({ markdown: "" });
  });

  test("a task row carries its after list", async () => {
    const { store, task } = await setup();
    const stored = await getTask(store, task.id);
    expect(taskViews.row(stored).after).toBeUndefined();
    await store.put(
      "task",
      task.id,
      { ...taskData(stored.data), after: [`${taskData(stored.data).repository}/t-9`] },
      "test:after",
    );
    const row = taskViews.row(await getTask(store, task.id));
    expect(row.after).toHaveLength(1);
    expect(row.after?.[0]).toContain("t-9");
  });

  test("a worker log line is one readable line, and bookkeeping is left out", () => {
    expect(
      readableLogLine(JSON.stringify({ type: "assistant", text: "I will edit\nthe file." })),
    ).toBe("assistant: I will edit the file.");
    expect(
      readableLogLine(JSON.stringify({ type: "tool_use", name: "Edit", input: { path: "a.ts" } })),
    ).toBe('tool Edit {"path":"a.ts"}');
    expect(readableLogLine(JSON.stringify({ type: "journal", event: "TurnStarted" }))).toBeUndefined();
    expect(
      readableLogLine(JSON.stringify({ type: "journal", event: "ToolExecutionStarted" })),
    ).toBe("tool: ToolExecutionStarted");
    expect(readableLogLine(JSON.stringify({ type: "Result", text: "done" }))).toBe("result: done");
    expect(readableLogLine("plain text")).toBe("plain text");
    expect(readableLogLine("   ")).toBeUndefined();
  });

  test("the log section is the tail of the current attempt's worker log", async () => {
    const { store, task } = await setup();
    const root = await tempRoot();
    const path = join(root, "worker.log");
    const lines = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify({ type: "assistant", text: `step ${index}` }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
    const stored = await getTask(store, task.id);
    await store.put(
      "task",
      task.id,
      { ...taskData(stored.data), attempt: { number: 1, workLog: path } },
      "test:log",
    );
    const section = (await taskViews.load(
      { store } as never,
      await getTask(store, task.id),
      "log",
      {},
    )) as { markdown: string };
    expect(section.markdown).toContain("assistant: step 199");
    expect(section.markdown).not.toContain("assistant: step 0\n");
    expect(section.markdown.split("\n\n")).toHaveLength(80);
    expect(taskViews.sections(await getTask(store, task.id)).find((item) => item.id === "log")?.live).toBe(true);
  });

  test("a tool call is one line with what ran and how long it took", () => {
    const lines = [
      { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", at: 1, input: "xcodebuild test -only-testing X" },
      { type: "tool_execution_end", toolCallId: "a", toolName: "Bash", isError: false, durationMs: 72000 },
      { type: "tool_execution_start", toolCallId: "b", toolName: "Read", at: 2, input: "/w/a.ts" },
      { type: "tool_execution_end", toolCallId: "b", toolName: "Read", isError: false, durationMs: 400 },
    ].map((line) => JSON.stringify(line));
    expect(readableLog(lines)).toEqual([
      "tool Bash 1m12s `xcodebuild test -only-testing X`",
      "tool Read <1s `/w/a.ts`",
    ]);
  });

  test("a call without an end line is marked running, with its start time", () => {
    const start = { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", at: Date.UTC(2026, 10, 7, 14, 3, 22), input: "sleep 9999" };
    expect(readableLog([JSON.stringify(start)])).toEqual(["tool Bash running since 14:03:22Z `sleep 9999`"]);
    // After the result line nothing is running any more.
    expect(readableLog([JSON.stringify(start), JSON.stringify({ type: "result", result: "failed" })])[0]).toBe(
      "tool Bash no end logged (started 14:03:22Z) `sleep 9999`",
    );
  });

  test("the agent's text, a tool error's first line and a turn's end are shown; tool output is not", () => {
    const lines = [
      { type: "message_end", role: "assistant", text: "I will run the tests.", stopReason: "tool_use", usage: { input: 120, output: 30 }, cost: { total: 0.0123 } },
      { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", at: 1, input: "false" },
      { type: "tool_execution_end", toolCallId: "a", toolName: "Bash", isError: true, durationMs: 2000, error: "exit code 1" },
      { type: "message_end", role: "assistant", stopReason: "end_turn", usage: { input: 1, output: 2 }, cost: null },
      { type: "result", result: "done", usage: { input: 5, output: 6 }, cost: { micros: 12346, quality: "exact" } },
    ].map((line) => JSON.stringify(line));
    expect(readableLog(lines)).toEqual([
      "**agent:** I will run the tests.",
      "turn ended: tool_use · 120 in / 30 out tokens · $0.0123",
      "tool Bash 2s `false`",
      "tool Bash failed: exit code 1",
      "result: done · 5 in / 6 out tokens · $0.0123",
    ]);
  });

  test("radian journal lines show the agent's text and each turn's usage; empty tool-call messages show nothing", () => {
    const lines = [
      { event: "MessageAppended", data: { index: 1, message: { assistant: { content: [{ text: { text: "Checking the build." } }], reasoning: [{ text: { text: "private" } }] } } } },
      { event: "MessageAppended", data: { index: 2, message: { assistant: { content: [], tool_calls: [{ id: "c" }] } } } },
      { event: "MessageAppended", data: { index: 0, message: { user: { content: [{ text: { text: "prompt" } }] } } } },
      { event: "ModelUsageRecorded", data: { usage: { input: 12, output: 3 }, fee: { micros: 1543 } } },
    ].map((line) => JSON.stringify(line));
    expect(readableLog(lines)).toEqual(["**agent:** Checking the build.", "turn ended: 12 in / 3 out tokens · $0.0015"]);
  });

  test("an agent paragraph of 300 characters is shown whole", () => {
    const text = "w".repeat(300);
    const line = JSON.stringify({ type: "message_end", role: "assistant", text, stopReason: "stop" });
    expect(readableLog([line])[0]).toBe(`**agent:** ${text}`);
  });

  test("a message_end text longer than 300 characters is cut at 300", () => {
    const line = JSON.stringify({ type: "message_end", role: "assistant", text: "w".repeat(400) });
    expect(readableLog([line])[0]).toBe(`**agent:** ${"w".repeat(299)}…`);
  });

  test("the log section says which agent each block is from when it mixes them", async () => {
    const { store, task } = await setup();
    const root = await tempRoot();
    const workLog = join(root, "worker.log");
    writeFileSync(
      workLog,
      `${JSON.stringify({ type: "tool_execution_start", toolCallId: "w", toolName: "Bash", at: 1, input: "make" })}\n`,
    );
    const reviewDir = join(store.root, "logs", "harness-pi", "runs", "run-9");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, "agent.log"),
      `${JSON.stringify({ type: "message_end", role: "assistant", text: "Looks fine.", stopReason: "stop" })}\n`,
    );
    const stored = await getTask(store, task.id);
    await store.put(
      "task",
      task.id,
      {
        ...taskData(stored.data),
        attempt: {
          number: 2,
          workLog,
          reviewRuns: [
            { round: 1, role: "primary", use: "harness-pi/agent", args: [], model: "gpt", reason: "initial", outcome: "report", run: "run-9" },
          ],
        },
      },
      "test:log",
    );
    const section = (await taskViews.load({ store } as never, await getTask(store, task.id), "log", {})) as {
      markdown: string;
    };
    const text = section.markdown;
    expect(text).toContain("**Worker, attempt 2**");
    expect(text).toContain("**Reviewer, round 1 (gpt)**");
    expect(text.indexOf("Worker, attempt 2")).toBeLessThan(text.indexOf("tool Bash"));
    expect(text.indexOf("tool Bash")).toBeLessThan(text.indexOf("Reviewer, round 1"));
    expect(text.indexOf("Reviewer, round 1")).toBeLessThan(text.indexOf("**agent:** Looks fine."));
  });

  test("the diff section is the stat and the diff, and pages by file when long", async () => {
    const root = await tempRoot();
    const remote = await makeRemote(root);
    const store = storeAt(root);
    const repository = await addRepository(store, { path: remote.repository, name: "repository" });
    const plan = await addPlan(store, { repository, slug: "p", title: "P", request: "r" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "b" });
    const branch = "work/T-0001-one";
    gitOrThrow(remote.repository, ["checkout", "-q", "-b", branch]);
    await commitIn(remote.repository, "small.txt", "hello\n", "small");
    gitOrThrow(remote.repository, ["checkout", "-q", "main"]);

    const short = (await taskViews.load(
      { store } as never,
      await getTask(store, task.id),
      "diff",
      {},
    )) as { markdown: string; next?: string };
    expect(short.markdown).toContain("small.txt");
    expect(short.markdown).toContain("````diff");
    expect(short.markdown).toContain("+hello");
    // The diffstat keeps git's leading space on its first line.
    expect(short.markdown).toMatch(/^````diff\n small\.txt /);
    expect(short.next).toBeUndefined();
    expect((short as { pages?: unknown }).pages).toBeUndefined();

    gitOrThrow(remote.repository, ["checkout", "-q", branch]);
    await commitIn(remote.repository, "big.txt", `${"x".repeat(100)}\n`.repeat(DIFF_PAGE_CHARS / 100 + 10), "big");
    gitOrThrow(remote.repository, ["checkout", "-q", "main"]);
    const object = await getTask(store, task.id);
    const first = (await taskViews.load({ store } as never, object, "diff", {})) as {
      markdown: string;
      next?: string;
    };
    expect(first.markdown).toContain("one page per file");
    expect(first.markdown).toContain("big.txt");
    expect(first.next).toBe("1");
    const tableOfContents = [
      { label: "overview" },
      { label: "big.txt", cursor: "1" },
      { label: "small.txt", cursor: "2" },
    ];
    expect((first as { pages?: unknown }).pages).toEqual(tableOfContents);
    const page1 = (await taskViews.load({ store } as never, object, "diff", { cursor: "1" })) as {
      markdown: string;
      next?: string;
    };
    expect(page1.markdown).toContain("### big.txt");
    expect(page1.next).toBe("2");
    expect((page1 as { pages?: unknown }).pages).toEqual(tableOfContents);
    const page2 = (await taskViews.load({ store } as never, object, "diff", { cursor: "2" })) as {
      markdown: string;
      next?: string;
    };
    expect(page2.markdown).toContain("### small.txt");
    expect(page2.next).toBeUndefined();
  });

  test("the metrics summary has at most four columns, a row per attempt and a total", async () => {
    const root = await tempRoot();
    const repositoryPath = await makeGitRepository(root);
    let clock = 0;
    const store = new FilePluginStore({ root: join(root, "store"), clock: () => clock });
    const repository = await addRepository(store, { path: repositoryPath });
    const plan = await addPlan(store, { repository, slug: "p", title: "P", request: "r" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "b" });
    const stored = taskData((await getTask(store, task.id)).data);
    const MIN = 60_000;
    const put = async (at: number, cause: string, attempt: Record<string, unknown>, phase = "running") => {
      clock = at;
      await store.put("task", task.id, { ...stored, phase, run: "run-1", attempt: { run: "run-1", ...attempt } }, cause);
    };
    const start = 1_000_000;
    // Attempt 1: worktree 2s, work 22m10s, verify 4m35s, review 18m, two findings.
    await put(start, "test:start", { number: 1 });
    await put(start + 2_000, "dev:worktree", { number: 1 });
    await put(start + 2_000 + 1_330_000, "dev:work", {
      number: 1, cost: 1.24, tokens: { input: 100, output: 35_900 }, workMs: 1_330_000,
    });
    await put(start + 2_000 + 1_330_000 + 275_000, "dev:verify", {
      number: 1, cost: 1.24, tokens: { input: 100, output: 35_900 }, verify: { result: "pass" },
    });
    const end1 = start + 2_000 + 1_330_000 + 275_000 + 1_080_000;
    await put(end1, "dev:review", {
      number: 1, cost: 1.24, tokens: { input: 100, output: 35_900 },
      review: { result: "findings", findings: [{}, {}] },
    }, "waiting");
    // Attempt 2 is running its work step.
    await put(end1 + 1_000, "test:rework", { number: 2 });
    await put(end1 + 3_000, "dev:worktree", { number: 2 });
    // The run's own facts: attempt 1's steps, a wait for a person, then attempt 2
    // enters its worktree step and is in its work step now.
    const work1 = start + 2_000 + 1_330_000;
    const runTimes = async () => ({
      startedAt: start,
      endedAt: null,
      segments: [
        { step: "worktree", person: false, from: start, to: start + 2_000 },
        { step: "work", person: false, from: start + 2_000, to: work1 },
        { step: "verify", person: false, from: work1, to: work1 + 275_000 },
        { step: "review", person: false, from: work1 + 275_000, to: end1 },
        { step: "confirm", person: true, from: end1, to: end1 + 3_000 },
        { step: "worktree", person: false, from: end1 + 3_000, to: end1 + 5_000 },
        { step: "work", person: false, from: end1 + 5_000, to: null },
      ],
    });
    const text = await metrics({ store, runTimes } as never, await getTask(store, task.id), end1 + 5_000 + 3 * MIN);
    const rows = text.split("\n");
    for (const row of rows.filter((line) => line.startsWith("|"))) {
      expect(row.split("|").length - 2).toBeLessThanOrEqual(4);
    }
    expect(rows.slice(0, 5)).toEqual([
      "| # | time | cost | result |",
      "| --- | --- | --- | --- |",
      "| 1 | 45m | $1.24 | review: 2 findings |",
      "| 2 | 3m … | – | running work |",
      "| total | 48m | $1.24 | |",
    ]);
    expect(rows[6]).toBe("**#2** worktree 2s · work 3m00s (running)");
    expect(rows[10]).toBe("**Waiting for a person** 3s");
    expect(rows[8]).toBe(
      "**#1** worktree 2s · work 22m10s · verify 4m35s · review 18m00s · 100 in / 35.9k out tokens",
    );
  });

  test("the total row sums the cost of every attempt", async () => {
    const root = await tempRoot();
    const repositoryPath = await makeGitRepository(root);
    let clock = 0;
    const store = new FilePluginStore({ root: join(root, "store"), clock: () => clock });
    const repository = await addRepository(store, { path: repositoryPath });
    const plan = await addPlan(store, { repository, slug: "p", title: "P", request: "r" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "b" });
    const stored = taskData((await getTask(store, task.id)).data);
    const put = async (at: number, cause: string, attempt: Record<string, unknown>, phase: string) => {
      clock = at;
      await store.put("task", task.id, { ...stored, phase, attempt: { run: "run-1", ...attempt } }, cause);
    };
    const start = 1_000_000;
    const runTimes = async () => ({
      startedAt: start,
      endedAt: start + 94_000,
      segments: [
        { step: "worktree", person: false, from: start, to: start + 5_000 },
        { step: "work", person: false, from: start + 5_000, to: start + 61_000 },
        { step: "worktree", person: false, from: start + 61_000, to: start + 94_000 },
      ],
    });
    await put(start - 1_000, "test:start", { number: 1 }, "running");
    await put(start, "dev:worktree", { number: 1, cost: 0.5 }, "running");
    await put(start + 60_000, "dev:verify", { number: 1, cost: 0.5, verify: { result: "fail" } }, "waiting");
    await put(start + 61_000, "dev:worktree", { number: 2, cost: 0.75 }, "running");
    await put(start + 93_000, "dev:review", { number: 2, cost: 0.75, review: { result: "passed" } }, "waiting");
    const rows = (await metrics({ store, runTimes } as never, await getTask(store, task.id), start + 100_000)).split("\n");
    expect(rows[2]).toBe("| 1 | 1m | $0.50 | verify failed |");
    expect(rows[3]).toBe("| 2 | 33s | $0.75 | review passed |");
    expect(rows[4]).toBe("| total | 2m | $1.25 | |");
  });

  test("the total row marks its weakest quality with a symbol, never a word", async () => {
    const root = await tempRoot();
    const repositoryPath = await makeGitRepository(root);
    let clock = 0;
    const store = new FilePluginStore({ root: join(root, "store"), clock: () => clock });
    const repository = await addRepository(store, { path: repositoryPath });
    const plan = await addPlan(store, { repository, slug: "p", title: "P", request: "r" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "b" });
    const stored = taskData((await getTask(store, task.id)).data);
    const put = async (at: number, cause: string, attempt: Record<string, unknown>) => {
      clock = at;
      await store.put("task", task.id, { ...stored, phase: "running", attempt }, cause);
    };
    const total = async () =>
      (await metrics({ store } as never, await getTask(store, task.id), 2_000_000)).split("\n").find((l) => l.startsWith("| total"));
    await put(1_000_000, "dev:worktree", { number: 1, cost: 0.5, costQuality: "estimated" });
    expect(await total()).toMatch(/\| ~\$0\.50 \| \|$/);
    await put(1_000_001, "dev:worktree", { number: 1, cost: 0.5, costQuality: "incomplete" });
    expect(await total()).toMatch(/\| ≥\$0\.50 \| \|$/);
  });

  test("how an attempt ended: merged, verify failed, conflict, cancelled", async () => {
    const { store, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    const result = async (attempt: Record<string, unknown>, phase: string, cause = "dev:integrate") => {
      await store.put("task", task.id, { ...stored, phase, attempt }, cause);
      const text = await metrics({ store } as never, await getTask(store, task.id), Date.now());
      return text.split("\n")[2]?.split("|")[4]?.trim();
    };
    expect(await result({ number: 1, integration: { result: "merged" } }, "merged")).toBe("merged");
    expect(await result({ number: 1, verify: { result: "fail" } }, "waiting", "dev:verify")).toBe("verify failed");
    expect(await result({ number: 1, integration: { result: "conflict" } }, "waiting")).toBe("conflict");
    expect(await result({ number: 1 }, "cancelled")).toBe("cancelled");
  });

  test("per-attempt lines leave out steps that did not run, and tokens show in k from 10k", async () => {
    const { store, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    await store.put("task", task.id, { ...stored, phase: "waiting", attempt: { number: 1, run: "run-1", tokens: { input: 9999, output: 10_000 } } }, "dev:work");
    // The run was in its work step for half a second and in no other step.
    const runTimes = async () => ({
      startedAt: 1_000_000,
      endedAt: 1_000_500,
      segments: [{ step: "work", person: false, from: 1_000_000, to: 1_000_500 }],
    });
    const text = await metrics({ store, runTimes } as never, await getTask(store, task.id), Date.now());
    const line = text.split("\n").find((row) => row.startsWith("**#1**"));
    expect(line).toBe("**#1** work <1s · 9999 in / 10.0k out tokens");
    expect(tokenCount(9_999)).toBe("9999");
    expect(tokenCount(10_000)).toBe("10.0k");
    expect(tokenCount(35_949)).toBe("35.9k");
  });

  test("a task row shows the last attempt's worker, short, and nothing before pools", async () => {
    const { store, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    const row = async () => taskViews.row(await getTask(store, task.id));
    await store.put("task", task.id, { ...stored, attempt: { number: 1 } }, "test:a");
    expect((await row()).note).toBe("$0.00");
    await store.put("task", task.id, { ...stored, attempt: { number: 1, worker: null } }, "test:a");
    expect((await row()).note ?? "").not.toContain("null");
    await store.put(
      "task",
      task.id,
      { ...stored, cost: 0.31, attempt: { number: 1, worker: "claude", fallbackFrom: null } },
      "test:a",
    );
    expect((await row()).note).toBe("$0.31 · claude");
    await store.put(
      "task",
      task.id,
      { ...stored, attempt: { number: 2, worker: "pi", fallbackFrom: "claude" } },
      "test:a",
    );
    expect((await row()).note).toBe("$0.00 · pi");
    const long = "a-very-long-worker-name-indeed";
    await store.put("task", task.id, { ...stored, attempt: { number: 2, worker: long } }, "test:a");
    const note = ((await row()).note ?? "").replace(/^\$0\.00 · /, "");
    expect(note.length).toBeLessThanOrEqual(ROW_WORKER_CHARS);
    expect(note.endsWith("…")).toBe(true);
  });

  test("the metrics section splits cost, time and first pass by worker", async () => {
    const { store, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    const metrics = async () =>
      (
        (await taskViews.load(
          { store } as never,
          await getTask(store, task.id),
          "metrics",
          {},
        )) as { markdown: string }
      ).markdown;
    // Zero workers: an attempt from before pools has no worker table.
    await store.put(
      "task",
      task.id,
      { ...stored, attempt: { number: 1, cost: 0.1, review: { result: "pass" as const } } },
      "dev:review",
    );
    expect(await metrics()).not.toContain("| worker |");
    expect(await metrics()).not.toContain("undefined");
    // One worker.
    await store.put(
      "task",
      task.id,
      {
        ...stored,
        attempt: { number: 1, worker: "claude", cost: 0.1, workMs: 60_000, review: { result: "pass" as const, round: 1 } },
      },
      "dev:review",
    );
    let lines = (await metrics()).split("\n");
    const at = lines.indexOf("| worker | attempts | cost | time | first pass |");
    expect(lines[at + 2]).toBe("| claude | 1 | $0.10 | <1s | 1/1 |");
    // Two workers: a fallback attempt, summed per worker.
    await store.put(
      "task",
      task.id,
      {
        ...stored,
        attempt: { number: 2, worker: "pi", fallbackFrom: "claude", cost: 0.05, review: { result: "failed" as const } },
      },
      "dev:review",
    );
    await store.put(
      "task",
      task.id,
      {
        ...stored,
        attempt: { number: 3, worker: "claude", cost: 0.2, review: { result: "passed" as const, round: 2 } },
      },
      "dev:review",
    );
    lines = (await metrics()).split("\n");
    const start = lines.indexOf("| worker | attempts | cost | time | first pass |");
    expect(lines.slice(start + 2)).toEqual([
      "| claude | 2 | $0.30 | <1s | 1/2 |",
      "| pi | 1 | $0.05 | <1s | 0/1 |",
    ]);
  });

  test("a task note is cost, worker, area, then a refused push", async () => {
    const { store, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    const row = async () => taskViews.row(await getTask(store, task.id)).note;
    await store.put("task", task.id, { ...stored, area: "app-core" }, "test:a");
    expect(await row()).toBe("$0.00 · area: app-core");
    await store.put(
      "task",
      task.id,
      { ...stored, phase: "ready", area: "app-core", areaHeldBy: "T-0023-action-numbers" },
      "test:a",
    );
    expect(await row()).toBe("$0.00 · waiting for area app-core (T-0023-action-numbers)");
    await store.put(
      "task",
      task.id,
      {
        ...stored,
        phase: "waiting",
        cost: 1.5,
        costQuality: "exact",
        area: "app-core",
        attempt: { number: 1, worker: "harness-claude", integration: { result: "failed", message: "push refused" } },
      },
      "test:a",
    );
    expect(await row()).toBe("$1.50 · harness-claude · area: app-core · push refused");
  });

  test("a plan note shows the cost of its tasks at the weakest quality", async () => {
    const { store, plan, task } = await setup();
    const second = await addTask(store, { plan: plan.id, slug: "two", title: "Two", brief: "# Brief\n\nx" });
    const note = async () => planViews.row(await getPlan(store, plan.id)).note;
    expect(await note()).toBe("0/2 · off · P3 // 1");
    const { putTaskKeepingPlanCost } = await import("../src/service.ts");
    const put = async (id: string, cost: number, q: "exact" | "estimated" | "incomplete" | undefined) => {
      const current = taskData((await getTask(store, id)).data);
      const { costQuality: _drop, ...rest } = current;
      await putTaskKeepingPlanCost(store, id, { ...rest, cost, ...(q === undefined ? {} : { costQuality: q }) }, "test:cost");
    };
    await put(task.id, 1.1, "exact");
    expect(await note()).toBe("0/2 · $1.10 · off · P3 // 1");
    await put(second.id, 0.2, undefined);
    expect(await note()).toBe("0/2 · ~$1.30 · off · P3 // 1");
    await put(second.id, 0.1, "incomplete");
    expect(await note()).toBe("0/2 · ≥$1.20 · off · P3 // 1");
    // A rework round raises the first task's cost: the total moves by the difference.
    await put(task.id, 1.6, "exact");
    expect(await note()).toBe("0/2 · ≥$1.70 · off · P3 // 1");
    await put(second.id, 0.1, "exact");
    expect(await note()).toBe("0/2 · $1.70 · off · P3 // 1");
  });

  test("a plan stored without a total gets one when its tasks are refreshed", async () => {
    const { store, plan, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    await store.put("task", task.id, { ...stored, cost: 2, costQuality: "exact" }, "test:raw");
    const { costTotals: _gone, ...old } = planData((await getPlan(store, plan.id)).data);
    await store.put("plan", plan.id, old, "test:old");
    expect(planViews.row(await getPlan(store, plan.id)).note).toBe("0/1 · off · P3 // 1");
    const { refreshPlanCounts } = await import("../src/service.ts");
    await refreshPlanCounts(store, await getPlan(store, plan.id));
    expect(planViews.row(await getPlan(store, plan.id)).note).toBe("0/1 · $2.00 · off · P3 // 1");
  });

  test("the plan note by auto level, and the total leaves cancelled tasks out", () => {
    const base = planData((({
      repository: "r", title: "t", request: "", status: "confirmed", auto: "off", priority: "P2",
      concurrency: 2, taskCount: 12, mergedCount: 1, cancelledCount: 5,
    }) as unknown) as Record<string, unknown>);
    expect(planNote(base)).toBe("1/7 · off · P2 // 2");
    expect(planNote({ ...base, auto: "run" })).toBe("1/7 · run · P2 // 2");
    expect(planNote({ ...base, auto: "merge" })).toBe("1/7 · merge · P2 // 2");
  });

  const WT = "/Users/hai/Code/operad/.operad-worktrees/T-0208-store-migrate";
  const toolLines = (command: string, extra: object[] = []): string[] =>
    [
      { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", at: 1, input: command },
      { type: "tool_execution_end", toolCallId: "a", toolName: "Bash", isError: false, durationMs: 3000 },
      ...extra,
    ].map((line) => JSON.stringify(line));

  test("a leading cd into the task's worktree is dropped, and its paths are relative; other cd targets stay", () => {
    const options = { worktree: WT };
    expect(readableLog(toolLines(`cd ${WT}; bun test packages/cli`), options)).toEqual(["tool Bash 3s `bun test packages/cli`"]);
    expect(readableLog(toolLines(`cd ${WT} && git status`), options)).toEqual(["tool Bash 3s `git status`"]);
    expect(readableLog(toolLines(`cd ${WT}; cat ${WT}/packages/cli/a.ts ${WT}`), options)).toEqual([
      "tool Bash 3s `cat packages/cli/a.ts .`",
    ]);
    expect(readableLog(toolLines(`cd /tmp/elsewhere; ls ${WT}-other`), options)).toEqual([
      `tool Bash 3s \`cd /tmp/elsewhere; ls ${WT}-other\``,
    ]);
    // Without a known worktree nothing is rewritten.
    expect(readableLog(toolLines(`cd ${WT}; ls`))[0]).toBe(`tool Bash 3s \`cd ${WT}; ls\``);
  });

  test("a multi-line command shows its first line and the count of lines left; a long one-liner is cut", () => {
    const heredoc = "python3 - <<'EOF'\nimport json\nprint(1)\nEOF";
    expect(readableLog(toolLines(`cd ${WT}; ${heredoc}`), { worktree: WT })).toEqual([
      "tool Bash 3s `python3 - <<'EOF' … (+3 lines)`",
    ]);
    // A blank line inside the command counts as a line left.
    expect(readableLog(toolLines("python3 - <<'EOF'\nprint(1)\n\nprint(2)\nEOF"))).toEqual([
      "tool Bash 3s `python3 - <<'EOF' … (+4 lines)`",
    ]);
    expect(readableLog(toolLines(`echo ${"x".repeat(300)}`))[0]).toBe(`tool Bash 3s \`echo ${"x".repeat(154)}…\``);
    const exact = `echo ${"y".repeat(155)}`;
    expect(exact).toHaveLength(160);
    expect(readableLog(toolLines(exact))[0]).toBe(`tool Bash 3s \`${exact}\``);
  });

  test("the command is inline code after the label; backticks inside it get a longer fence", () => {
    expect(readableLog(toolLines("echo `date`"))[0]).toBe("tool Bash 3s `` echo `date` ``");
    const failed = [
      { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", at: 1, input: "false" },
      { type: "tool_execution_end", toolCallId: "a", toolName: "Bash", isError: true, durationMs: 1000, error: "exit code 1" },
    ].map((line) => JSON.stringify(line));
    expect(readableLog(failed)).toEqual(["tool Bash 1s `false`", "tool Bash failed: exit code 1"]);
  });

  test("a run of tool turns shows no turn end; a turn end after the agent's text and the result stay", () => {
    const usage = { input: 2, output: 6 };
    const lines = [
      { type: "message_end", role: "assistant", stopReason: "tool_use", usage },
      ...toolLines("ls").map((line) => JSON.parse(line) as object),
      { type: "message_end", role: "assistant", stopReason: "tool_use", usage },
      { type: "message_end", role: "assistant", text: "Tests pass.", stopReason: "end_turn", usage },
      { type: "message_end", role: "assistant", stopReason: "end_turn", usage },
      { type: "result", result: "done", usage: { input: 9, output: 9 }, cost: { micros: 20000 } },
    ].map((line) => JSON.stringify(line));
    expect(readableLog(lines)).toEqual([
      "tool Bash 3s `ls`",
      "**agent:** Tests pass.",
      "turn ended: end_turn · 2 in / 6 out tokens",
      "result: done · 9 in / 9 out tokens · $0.0200",
    ]);
  });

  test("radian turn usage without agent text is not shown", () => {
    const lines = [
      { event: "MessageAppended", data: { message: { assistant: { content: [], tool_calls: [{ id: "c" }] } } } },
      { event: "ModelUsageRecorded", data: { usage: { input: 12, output: 3 } } },
    ].map((line) => JSON.stringify(line));
    expect(readableLog(lines)).toEqual([]);
  });
});
