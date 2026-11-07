import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "@operad-io/engine";
import plugin from "../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  claimWaitingTask,
  getTask,
  setTaskPhase,
} from "../src/service.ts";
import { taskData, type TaskAttempt, type TaskData } from "../src/model.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  storeAt,
  tempRoot,
} from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ACTOR = { via: "test", id: "lead" } as const;
const CHILD = fileURLToPath(
  new URL("./fixtures/lead-action-child.ts", import.meta.url),
);

/** Reads one line at a time from a child's stdout; undefined once it ends. */
function lines(stream: ReadableStream<Uint8Array>): () => Promise<string | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length === 0) return undefined;
        const line = buffer;
        buffer = "";
        return line;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

async function setup(failAnswer = false) {
  const answers: [string, string | undefined][] = [];
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const registry = new PluginRegistry([plugin], {
    store,
    storeRoot: store.root,
    onAnswer: async (_runId, choice, note) => {
      if (failAnswer) throw new Error("the run is not waiting");
      answers.push([choice, note]);
    },
  });
  const repository = await addRepository(store, { path: repositoryPath });
  const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
  const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
  return { root, repositoryPath, store, registry, task, answers };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function patch(
  fixture: Fixture,
  change: Partial<TaskData>,
): Promise<void> {
  const current = taskData((await getTask(fixture.store, fixture.task.id)).data);
  await fixture.store.put(
    "task",
    fixture.task.id,
    { ...current, ...change },
    "test",
  );
}

async function run(fixture: Fixture, name: "rework" | "reverify", note?: string) {
  return fixture.registry.runAction(
    `dev/${name}`,
    note === undefined ? {} : { note },
    {
      object: await getTask(fixture.store, fixture.task.id),
      runId: "run-1",
      actor: ACTOR,
    },
  );
}

const GATED: TaskAttempt = {
  number: 1,
  run: "run-1",
  worktree: "/tmp/none",
  verified: "abc123",
  verify: { result: "pass", run: "run-1" },
  review: { result: "pass", run: "run-1", sha: "abc123" } as never,
  reviews: 1,
  rework: { run: "run-1", source: "review", streak: 2, result: "ask" },
};

/** The waiting states a lead acts on, as the task data they leave. */
const WAITS: Readonly<Record<string, Partial<TaskData>>> = {
  "a passed review": { attempt: GATED, reworkStreak: 0 },
  "a gate failure": {
    attempt: {
      ...GATED,
      verify: { result: "fail", run: "run-1", message: "flaky" },
      review: null,
    },
    reworkStreak: 3,
  },
  "work that returned nothing": {
    attempt: { number: 1, run: "run-1", result: "failed", worked: true },
  },
};

describe("dev:rework and dev:reverify", () => {
  for (const [state, data] of Object.entries(WAITS)) {
    test(`rework from ${state} writes a lead section and answers reject`, async () => {
      const fixture = await setup();
      await setTaskPhase(fixture.store, fixture.task.id, "waiting");
      await patch(fixture, data);

      await run(fixture, "rework", "cover the empty case");

      expect(fixture.answers).toEqual([["reject", "cover the empty case"]]);
      const after = taskData((await getTask(fixture.store, fixture.task.id)).data);
      expect(after.brief).toContain("## Rework 1 (lead)");
      expect(after.brief).toContain("cover the empty case");
      expect(after.phase).toBe("running");
      expect(after.reworkStreak).toBe(0);
    });

    test(`reverify from ${state} clears the gate results and answers reverify`, async () => {
      const fixture = await setup();
      await setTaskPhase(fixture.store, fixture.task.id, "waiting");
      await patch(fixture, data);
      const before = taskData((await getTask(fixture.store, fixture.task.id)).data);

      await run(fixture, "reverify");

      expect(fixture.answers).toEqual([["reverify", undefined]]);
      const after = taskData((await getTask(fixture.store, fixture.task.id)).data);
      expect(after.phase).toBe("running");
      expect(after.attempt?.verify).toBeNull();
      expect(after.attempt?.review).toBeNull();
      expect(after.attempt?.verified).toBeNull();
      expect(after.attempt?.rework).toBeNull();
      expect(after.attempt?.number).toBe(1);
      // No worker, no rework section, and the streak is the gate's to count.
      expect(after.brief).not.toContain("## Rework");
      expect(after.reworkStreak).toBe(before.reworkStreak);
    });
  }

  test("a lead rework resets the streak of automatic reworks, and numbers on", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, { attempt: GATED, reworkStreak: 2 });

    await run(fixture, "rework", "first");
    expect(taskData((await getTask(fixture.store, fixture.task.id)).data).reworkStreak).toBe(0);

    await patch(fixture, { phase: "waiting", reworkStreak: 2 });
    await run(fixture, "rework", "second");
    const after = taskData((await getTask(fixture.store, fixture.task.id)).data);
    expect(after.brief).toContain("## Rework 2 (lead)");
    expect(after.reworkStreak).toBe(0);
  });

  test("rework needs a note; reverify takes none", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, { attempt: GATED });
    await expect(run(fixture, "rework")).rejects.toThrow(/note/);
    await expect(run(fixture, "rework", "   ")).rejects.toThrow(/non-empty/);
    expect(fixture.answers).toEqual([]);
  });

  for (const phase of ["running", "merged", "ready"] as const) {
    test(`both refuse a ${phase} task and change nothing`, async () => {
      const fixture = await setup();
      await patch(fixture, { phase, attempt: GATED });
      const before = await getTask(fixture.store, fixture.task.id);

      await expect(run(fixture, "rework", "x")).rejects.toThrow(
        new RegExp(`is ${phase}, not waiting`),
      );
      await expect(run(fixture, "reverify")).rejects.toThrow(
        new RegExp(`is ${phase}, not waiting`),
      );
      expect(fixture.answers).toEqual([]);
      expect((await getTask(fixture.store, fixture.task.id)).version).toBe(
        before.version,
      );
      const pending = await fixture.registry.pending([
        { runId: "run-1", object: { type: "task", id: fixture.task.id } },
      ]);
      const names = pending[0]?.actions.map((action) => action.action) ?? [];
      expect(names).not.toContain("rework");
      expect(names).not.toContain("reverify");
    });
  }

  test("a review waiting for its model offers no merge, reject, rework or reverify", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, {
      retryAt: Date.now() + 120_000,
      attempt: {
        ...GATED,
        review: {
          result: "unavailable",
          decision: "unavailable",
          round: 1,
          retryAt: Date.now() + 120_000,
        } as never,
      },
    });
    const pending = await fixture.registry.pending([
      { runId: "run-1", object: { type: "task", id: fixture.task.id } },
    ]);
    const names = pending[0]?.actions.map((action) => action.action) ?? [];
    for (const name of ["merge", "reject", "rework", "reverify"]) {
      expect(names).not.toContain(name);
    }
  });

  test("pending lists both after merge and reject", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    const pending = await fixture.registry.pending([
      { runId: "run-1", object: { type: "task", id: fixture.task.id } },
    ]);
    const names = pending[0]?.actions.map((action) => action.action) ?? [];
    expect(names.slice(names.indexOf("merge"))).toEqual([
      "merge",
      "reject",
      "rework",
      "reverify",
    ]);
  });

  test("reverify of a task that never worked refuses and leaves it alone", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    const before = await getTask(fixture.store, fixture.task.id);
    await expect(run(fixture, "reverify")).rejects.toThrow(/no work to verify/);
    expect(fixture.answers).toEqual([]);
    expect((await getTask(fixture.store, fixture.task.id)).version).toBe(before.version);
  });

  test("an answer that fails gives the claim back", async () => {
    const fixture = await setup(true);
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, { attempt: GATED, reworkStreak: 2 });
    const before = taskData((await getTask(fixture.store, fixture.task.id)).data);

    await expect(run(fixture, "rework", "x")).rejects.toThrow(/not waiting/);
    const after = taskData((await getTask(fixture.store, fixture.task.id)).data);
    expect(after.brief).toBe(before.brief);
    expect(after.phase).toBe("waiting");
    expect(after.reworkStreak).toBe(2);
  });

  test("a second claim on the same version loses and reports what happened", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    const seen = (await getTask(fixture.store, fixture.task.id)).version;

    await claimWaitingTask(fixture.store, fixture.task.id, seen, "rework", (latest) => latest);
    await expect(
      claimWaitingTask(fixture.store, fixture.task.id, seen, "rework", (latest) => latest),
    ).rejects.toThrow(/changed since you looked/);
  });

  test("an action offered a stale object loses even while the task still waits", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, { attempt: GATED });
    const stale = await getTask(fixture.store, fixture.task.id);

    // Merge leaves the task waiting, so only the version tells the two apart.
    await fixture.registry.runAction(
      "dev/merge",
      {},
      { object: stale, runId: "run-1", actor: ACTOR },
    );
    await expect(
      fixture.registry.runAction(
        "dev/rework",
        { note: "again" },
        { object: stale, runId: "run-1", actor: ACTOR },
      ),
    ).rejects.toThrow(/changed since you looked/);
    expect(fixture.answers).toHaveLength(1);
  });

  test("a cancel that lands first wins over a rework", async () => {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, { attempt: GATED });
    const stale = await getTask(fixture.store, fixture.task.id);
    await fixture.registry.runAction("dev/cancel", {}, { object: stale, actor: ACTOR });
    await expect(
      claimWaitingTask(fixture.store, fixture.task.id, stale.version, "rework", (l) => l),
    ).rejects.toThrow(/it is cancelled/);
  });

  async function race(first: [string, unknown], second: [string, unknown]) {
    const fixture = await setup();
    await setTaskPhase(fixture.store, fixture.task.id, "waiting");
    await patch(fixture, { attempt: GATED, reworkStreak: 2 });
    const answersPath = join(fixture.root, "answers.txt");
    const children = [first, second].map(([action, args]) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          CHILD,
          fixture.store.root,
          fixture.repositoryPath,
          fixture.task.id,
          action,
          JSON.stringify(args),
          answersPath,
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const nextLines = children.map((child) => lines(child.stdout));
    const errors = children.map((child) => new Response(child.stderr).text());
    // Both children read the task before either acts; once both are ready, one
    // go line lets them claim the same version at the same time.
    expect(await Promise.all(nextLines.map((next) => next()))).toEqual([
      "ready",
      "ready",
    ]);
    for (const child of children) {
      child.stdin.write("go\n");
      child.stdin.end();
    }
    const outputs = await Promise.all(
      nextLines.map(async (next) => {
        const rest: string[] = [];
        for (;;) {
          const line = await next();
          if (line === undefined) break;
          rest.push(line);
        }
        return rest.at(-1) ?? "";
      }),
    );
    for (const [index, child] of children.entries()) {
      expect(await child.exited).toBe(0);
      expect(await errors[index]).toBe("");
    }
    const answers = existsSync(answersPath)
      ? readFileSync(answersPath, "utf8").trim().split("\n")
      : [];
    return { fixture, outputs, answers };
  }

  test("rework racing merge in two processes: exactly one wins", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { fixture, outputs, answers } = await race(
        ["dev/rework", { note: "again" }],
        ["dev/merge", {}],
      );
      expect(outputs.filter((line) => line === "won")).toHaveLength(1);
      expect(outputs.filter((line) => line.startsWith("lost: "))).toHaveLength(1);
      expect(answers).toHaveLength(1);
      const brief = taskData((await getTask(fixture.store, fixture.task.id)).data).brief;
      // The loser leaves nothing behind: a rework section only if rework won.
      expect(brief.includes("## Rework 1 (lead)")).toBe(
        answers[0] === "dev/rework:reject",
      );
    }
  });

  test("two reworks on the same task in two processes: exactly one wins", async () => {
    const { fixture, outputs, answers } = await race(
      ["dev/rework", { note: "one" }],
      ["dev/rework", { note: "two" }],
    );
    expect(outputs.filter((line) => line === "won")).toHaveLength(1);
    expect(answers).toHaveLength(1);
    const brief = taskData((await getTask(fixture.store, fixture.task.id)).data).brief;
    expect(brief.match(/## Rework/g)).toHaveLength(1);
  });
});
