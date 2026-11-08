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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIFF_PAGE_CHARS,
  planViews,
  readableLog,
  readableLogLine,
  taskViews,
} from "../src/views.ts";
import { commitIn, gitOrThrow, makeRemote } from "./git-support.ts";
import { bareId, taskData } from "../src/model.ts";
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

  test("a plan row shows the derived state and merged/total", async () => {
    const { store, plan, task } = await setup();
    const confirmed = await getPlan(store, plan.id);
    expect(planViews.row(confirmed)).toEqual({
      id: "P-0001-storage",
      title: "Storage",
      state: "draft",
      note: "0/1  auto: off  P3  concurrency: 1",
      scope: "repository",
      mark: "proposed",
    });
    await setTaskPhase(store, task.id, "merged");
    expect(planViews.row(await getPlan(store, plan.id)).note).toBe(
      "1/1  auto: off  P3  concurrency: 1",
    );
  });

  test("a task row reads the phase and the cost", async () => {
    const { store, task } = await setup();
    const stored = await getTask(store, task.id);
    expect(taskViews.row(stored)).toEqual({
      id: "T-0001-jsonl",
      title: "JSONL",
      state: "proposed",
      scope: "repository",
      mark: "proposed",
      badge: "#0",
    });
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
        note: `$0.31 (${quality})`,
      });
    }
  });

  test("a task has brief and changes, and rework only after it has some", async () => {
    const { store, task } = await setup();
    const before = await getTask(store, task.id);
    expect(planViews.sections(before)).toEqual([
      { id: "request", title: "Request" },
      { id: "tasks", title: "Tasks" },
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
    ).toContain("- created");

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

  test("a plan loads its request and a table of tasks", async () => {
    const { store, plan, task } = await setup();
    const stored = await getPlan(store, plan.id);
    expect(await planViews.load({ store } as never, stored, "request", {})).toEqual({
      markdown: "# Request\n\nWrite the store.",
    });
    const table = (await planViews.load(
      { store } as never,
      stored,
      "tasks",
      {},
    )) as { markdown: string };
    expect(table.markdown).toContain("| id | title | phase | after |");
    expect(table.markdown).toContain(
      `| ${bareId(task.id)} | JSONL | proposed | - |`,
    );
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
      "tool Bash 1m12s  xcodebuild test -only-testing X",
      "tool Read <1s  /w/a.ts",
    ]);
  });

  test("a call without an end line is marked running, with its start time", () => {
    const start = { type: "tool_execution_start", toolCallId: "a", toolName: "Bash", at: Date.UTC(2026, 10, 7, 14, 3, 22), input: "sleep 9999" };
    expect(readableLog([JSON.stringify(start)])).toEqual(["tool Bash running since 14:03:22Z  sleep 9999"]);
    // After the result line nothing is running any more.
    expect(readableLog([JSON.stringify(start), JSON.stringify({ type: "result", result: "failed" })])[0]).toBe(
      "tool Bash no end logged (started 14:03:22Z)  sleep 9999",
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
      "tool Bash 2s  false",
      "tool Bash failed: exit code 1",
      "turn ended: end_turn · 1 in / 2 out tokens",
      "result: done · 5 in / 6 out tokens · $0.0123",
    ]);
  });

  test("an agent paragraph of 300 characters is shown whole", () => {
    const text = "w".repeat(300);
    const line = JSON.stringify({ type: "message_end", role: "assistant", text, stopReason: "stop" });
    expect(readableLog([line])[0]).toBe(`**agent:** ${text}`);
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
    const page1 = (await taskViews.load({ store } as never, object, "diff", { cursor: "1" })) as {
      markdown: string;
      next?: string;
    };
    expect(page1.markdown).toContain("### big.txt");
    expect(page1.next).toBe("2");
    const page2 = (await taskViews.load({ store } as never, object, "diff", { cursor: "2" })) as {
      markdown: string;
      next?: string;
    };
    expect(page2.markdown).toContain("### small.txt");
    expect(page2.next).toBeUndefined();
  });

  test("the metrics section has one row per attempt with time, cost, tokens and review", async () => {
    const { store, task } = await setup();
    const stored = taskData((await getTask(store, task.id)).data);
    const attempt = {
      number: 1,
      cost: 0.31,
      tokens: { input: 1200, output: 340 },
      workMs: 125_000,
      review: { result: "pass" as const },
    };
    for (const cause of ["dev:worktree", "dev:work", "dev:verify", "dev:review"]) {
      await store.put("task", task.id, { ...stored, attempt }, cause);
    }
    await store.put(
      "task",
      task.id,
      {
        ...stored,
        attempt: { number: 2, cost: 0.05, costQuality: "incomplete" as const, review: { result: "fail" as const } },
      },
      "dev:review",
    );
    const section = (await taskViews.load(
      { store } as never,
      await getTask(store, task.id),
      "metrics",
      {},
    )) as { markdown: string };
    const rows = section.markdown.split("\n");
    expect(rows[0]).toBe("| attempt | worktree | work | verify | review | integrate | cost | tokens | review |");
    expect(rows[2]).toContain("| 1 |");
    expect(rows[2]).toContain("2m05s");
    expect(rows[2]).toContain("$0.31 | 1200 in / 340 out | pass |");
    expect(rows[3]).toContain("| 2 |");
    expect(rows[3]).toContain("$0.05 (incomplete) | - | fail |");
  });
});
