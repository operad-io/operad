import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineFlow, definePlugin } from "../../src/index.ts";
import {
  answer,
  cleanup,
  emit,
  fakeClock,
  memoryStore,
  resume,
  runFlow,
  testWorld,
  type FlowRun,
} from "../../src/testing/index.ts";

afterAll(cleanup);

/** These plugins are definitions in this file, so their steps run in this process. */
const local = { inProcess: true } as const;

function single(name: string, use: string, edges: Record<string, string>) {
  return defineFlow({
    name,
    entry: "work",
    steps: [
      {
        id: "work",
        kind: "plugin",
        params: { use, params: {} },
        replay: "safe",
        next: edges,
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ...(Object.values(edges).includes("failed")
        ? [{ id: "failed", kind: "end" as const, params: { status: "failed" as const }, replay: "safe" as const }]
        : []),
    ],
  });
}

const plugin = definePlugin({
  name: "probe",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "thing" }],
  steps: [
    {
      name: "explode",
      results: ["ok", "failed"],
      run: () => {
        throw new Error("the disk is on fire");
      },
    },
    {
      name: "stuck",
      results: ["ok", "interrupted"],
      run: () => new Promise(() => undefined),
    },
    {
      name: "echo",
      results: ["ok"],
      enforces: ["denyPaths"],
      run: async (ctx) => {
        const secret = await ctx.secrets.get("token");
        return {
          result: "ok",
          data: {
            mode: String(ctx.settings.mode),
            tokenLength: secret?.reveal().length ?? 0,
            access: JSON.stringify(ctx.access),
          },
        };
      },
    },
  ],
  flows: [
    single("explode", "probe/explode", { ok: "done", failed: "failed" }),
    single("stuck", "probe/stuck", { ok: "done", interrupted: "failed" }),
    single("echo", "probe/echo", { ok: "done" }),
    defineFlow({
      name: "pause",
      entry: "pause",
      steps: [
        {
          id: "pause",
          kind: "wait",
          params: { afterSecs: 60 },
          replay: "safe",
          next: { ready: "done", interrupted: "failed" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
        { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      ],
    }),
    defineFlow({
      name: "ask",
      entry: "ask",
      steps: [
        {
          id: "ask",
          kind: "wait_person",
          params: { prompt: "Go?", choices: ["go", "stop"] },
          replay: "safe",
          next: { go: "done", stop: "failed", interrupted: "failed" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
        { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      ],
    }),
  ],
  settings: {
    type: "object",
    properties: { mode: { type: "string", default: "plain" } },
  },
  rules: [
    {
      source: "mail",
      type: "mail.received",
      start: { flow: "echo" },
      object: "thing:7",
      mode: "auto",
    },
  ],
});

describe("runFlow", () => {
  test("a step that throws ends failed with its message in the facts", async () => {
    const run = await runFlow(plugin, "explode", local);
    expect(run.status).toBe("ended");
    expect(run.end).toBe("failed");
    expect(JSON.stringify(run.facts)).toContain("the disk is on fire");
    expect(run.history.join("\n")).toContain("the disk is on fire");
  });

  test("with a fake clock a step timeout ends interrupted", async () => {
    const clock = fakeClock();
    const running = runFlow(plugin, "stuck", { ...local, clock });
    await clock.whenTimer();
    expect(clock.pending).toBe(1);
    clock.advance(5 * 60 * 1000);
    const run = await running;
    expect(run.end).toBe("failed");
    const results = run.facts.filter((fact) => fact.kind === "step_result");
    expect(JSON.stringify(results)).toContain('"result":"interrupted"');
    expect(JSON.stringify(run.facts)).toContain("took longer than");
  });

  test("a step timeout does not fire before the clock passes it", async () => {
    const clock = fakeClock();
    const running = runFlow(plugin, "stuck", { ...local, clock });
    await clock.whenTimer();
    clock.advance(5 * 60 * 1000 - 1);
    expect(clock.pending).toBe(1);
    clock.advance(1);
    expect((await running).status).toBe("ended");
  });

  test("a time wait is blocked until the clock passes it, then resumes", async () => {
    const clock = fakeClock(1_000);
    const run = await runFlow(plugin, "pause", { ...local, clock });
    expect(run.status).toBe("blocked");
    expect((await resume(run)).status).toBe("blocked");
    clock.advance(60_000);
    const done = await resume(run);
    expect(done.end).toBe("done");
  });

  test("a person wait is answered by id, and only with a choice it offers", async () => {
    const run = await runFlow(plugin, "ask", local);
    const wait = run.wait;
    if (wait === undefined) throw new Error("expected a wait");
    expect(wait).toMatchObject({ prompt: "Go?", choices: ["go", "stop"] });
    await expect(answer(run, "not-the-wait", "go")).rejects.toThrow(/not the one/);
    await expect(answer(run, wait.id, "maybe")).rejects.toThrow(/"maybe"/);
    const done = await answer(run, wait.id, "stop", "not today");
    expect(done.end).toBe("failed");
    await expect(answer(done, wait.id, "go")).rejects.toThrow(/not waiting/);
  });

  test("settings, secrets and the access profile reach the step", async () => {
    const run = await runFlow(plugin, "echo", {
      ...local,
      settings: { mode: "loud" },
      secrets: { token: "s3cret" },
      access: { denyPaths: ["/etc"] },
    });
    expect(run.end).toBe("done");
    const text = JSON.stringify(run.facts);
    expect(text).toContain("loud");
    expect(text).toContain('"tokenLength":6');
    expect(text).toContain('{\\"denyPaths\\":[\\"/etc\\"]}');
    // The step read the secret; the log holds only what the step reported.
    expect(text).not.toContain("s3cret");
  });

  test("a store given to the run is the store the step writes", async () => {
    const store = memoryStore();
    await store.put("thing", "9", { seeded: true }, "test");
    const run = await runFlow(plugin, "echo", { ...local, store, object: { type: "thing", id: "9" } });
    expect(run.store).toBe(store);
    expect((await store.get("thing", "9"))?.data).toEqual({ seeded: true });
  });

  test("an unknown flow is an error naming it", async () => {
    await expect(runFlow(plugin, "nope", local)).rejects.toThrow('no flow "nope"');
  });
});

describe("emit", () => {
  test("starts the flow a rule names", async () => {
    const sent = await emit(plugin, "mail", "mail.received", { subject: "hi" }, local);
    expect(sent.started).toBe(true);
    expect(sent.result.flow).toBe("echo");
    expect(sent.run?.end).toBe("done");
  });

  test("an event no rule matches starts nothing", async () => {
    const sent = await emit(plugin, "mail", "mail.other", undefined, local);
    expect(sent.started).toBe(false);
    expect(sent.run).toBeUndefined();
    expect(sent.result.kind).toBe("recorded");
  });
});

const isolation = join(import.meta.dir, "..", "fixtures", "plugins", "testing-isolation.ts");
const chain = join(import.meta.dir, "..", "fixtures", "plugins", "testing-chain.ts");

describe("isolation", () => {
  function counts(run: FlowRun): number[] {
    return run.facts.flatMap((fact) => {
      const payload = fact.payload as { data?: { calls?: unknown } } | null;
      return fact.kind === "step_result" && typeof payload?.data?.calls === "number"
        ? [payload.data.calls]
        : [];
    });
  }

  test("a plugin given by path runs its steps in a worker, as serve does", async () => {
    const run = await runFlow(isolation, "twice");
    // Each step starts from a fresh module: module state does not carry over.
    expect(counts(run)).toEqual([1, 1]);
  });

  test("in process, module state is shared: faster, not isolated", async () => {
    const run = await runFlow(isolation, "twice", { inProcess: true });
    expect(counts(run)).toEqual([1, 2]);
  });

  test("a value a worker cannot hand back fails the step, as under serve", async () => {
    const run = await runFlow(isolation, "clone");
    expect(run.end).toBe("failed");
  });

  test("a fake clock times out a step in a worker too", async () => {
    const clock = fakeClock();
    const running = runFlow(isolation, "stuck", { clock });
    await clock.whenTimer();
    clock.advance(5 * 60 * 1000);
    const run = await running;
    expect(run.end).toBe("done");
    expect(JSON.stringify(run.facts)).toContain("took longer than");
  });

  test("a definition without inProcess is refused, and says what to do", async () => {
    await expect(runFlow(plugin, "echo")).rejects.toThrow(/module path/);
  });

  test("a store of your own needs inProcess", async () => {
    await expect(runFlow(isolation, "twice", { store: memoryStore() })).rejects.toThrow(
      /inProcess/,
    );
  });
});

describe("one world across calls", () => {
  test("the same key arriving twice starts one run", async () => {
    const world = await testWorld(chain);
    const first = await world.emit("mail", "mail.received", undefined, { key: "m1" });
    expect(first.started).toBe(true);
    const again = await world.emit("mail", "mail.received", undefined, { key: "m1" });
    expect(again.started).toBe(false);
    expect(again.result.duplicate).toBe(true);
    expect(await world.runs()).toHaveLength(1);
    // A different key is a different event.
    const other = await world.emit("mail", "mail.received", undefined, { key: "m2" });
    expect(other.started).toBe(false); // the first run still holds job:1
    await world.close();
  });

  test("an answer ends the run, and the rule on its end starts the next run", async () => {
    const world = await testWorld(chain);
    const run = await world.runFlow("first");
    const wait = run.wait;
    if (wait === undefined) throw new Error("expected a wait");
    const done = await answer(run, wait.id, "go");
    expect(done.end).toBe("done");

    const runs = await world.runs();
    expect(runs.map((item) => item.flow)).toEqual(["first", "second"]);
    // The run the rule started was run, not left idle.
    expect(runs[1]?.end).toBe("cancelled");
    await world.close();
  });

  test("a run that ends by itself starts the next run, and it is run", async () => {
    const world = await testWorld(chain);
    const run = await world.runFlow("third");
    expect(run.end).toBe("done");
    const runs = await world.runs();
    expect(runs.map((item) => item.flow)).toEqual(["third", "second"]);
    expect(runs[1]?.end).toBe("cancelled");
    await world.close();
  });

  test("a run that a rule starts from an event runs too", async () => {
    const sent = await emit(chain, "mail", "mail.received");
    expect(sent.started).toBe(true);
    expect(sent.run?.status).toBe("waiting_person");
  });
});
