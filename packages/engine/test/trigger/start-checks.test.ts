import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  listPending,
  StartRefusedError,
  defineFlow,
  definePlugin,
  openLog,
  serveOnce,
  type PluginDefinition,
  type TriggerRule,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const AGENT = { name: "agent", results: ["ok"], run: () => ({ result: "ok" }) };

function poolPlugin(extra: { readonly requires?: { readonly plugins: Record<string, string> } } = {}) {
  return def({ name: "pool", steps: [AGENT], ...extra });
}

/** `app/outer` calls `pool/agent` (declared), in a flow that uses only `app/outer`. */
function appPlugin(calls: readonly string[] | "none" = ["pool/agent"]): PluginDefinition {
  return def({
    name: "app",
    steps: [
      {
        name: "outer",
        ...(calls === "none" ? {} : { calls }),
        results: ["ok"],
        run: async (ctx) => {
          const run = ctx.runStep;
          if (run === undefined) throw new Error("no host");
          await run("pool/agent", {}, { runId: ctx.runId });
          return { result: "ok" };
        },
      },
    ],
    flows: [
      defineFlow({
        name: "job",
        entry: "outer",
        steps: [
          {
            id: "outer",
            kind: "plugin",
            params: { use: "app/outer", params: {} },
            replay: "safe",
            next: { ok: "done" },
          },
          { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
        ],
      }),
    ],
  });
}

const RULE: TriggerRule = {
  source: "cron",
  type: "tick",
  start: { flow: "job" },
  object: "job:1",
  mode: "auto",
};

async function env(
  plugins: readonly PluginDefinition[],
  options: { readonly disabled?: readonly string[]; readonly root?: string } = {},
) {
  const root = options.root ?? (await tempRoot());
  const storeRoot = join(root, "store");
  const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
  const logs: string[] = [];
  const registry = new PluginRegistry(plugins, {
    home: root,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
    onLog: (line) => logs.push(line),
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
  });
  const kernel = new Kernel({ log, registry, home: root, storeRoot, rules: [RULE] });
  return { root, storeRoot, log, registry, kernel, logs };
}

describe("a start whose called step is not loaded", () => {
  test("a flow with every step loaded can start", async () => {
    const e = await env([appPlugin(), poolPlugin()]);
    expect(e.registry.startProblem("job")).toBeUndefined();
    const result = await e.kernel.start({ flow: "job", object: "job:1" });
    expect(result.kind).toBe("started");
    await e.log.close();
  });

  test("disabled: refused with the step, the plugin and the command", async () => {
    const e = await env([appPlugin()], { disabled: ["pool"] });
    const message =
      'cannot start: needs "pool/agent" from plugin pool, which is disabled (operad plugin enable pool)';
    expect(e.registry.startProblem("job")).toBe(message);
    await expect(e.kernel.start({ flow: "job", object: "job:1" })).rejects.toThrow(
      message,
    );
    expect(await e.log.runs()).toEqual([]);
    await e.log.close();
  });

  test("refused: names the plugin's own reason", async () => {
    const e = await env([appPlugin(), poolPlugin({ requires: { plugins: { gone: "^1.0.0" } } })]);
    const problem = e.registry.startProblem("job");
    expect(problem).toContain('needs "pool/agent" from plugin pool, which was refused');
    expect(problem).toContain('"gone" is not loaded');
    await e.log.close();
  });

  test("absent: the plugin is not loaded at all", async () => {
    const e = await env([appPlugin()]);
    expect(e.registry.startProblem("job")).toBe(
      'cannot start: needs "pool/agent" from plugin pool, which is not loaded',
    );
    await expect(e.kernel.start({ flow: "job", object: "job:1" })).rejects.toBeInstanceOf(
      StartRefusedError,
    );
    await e.log.close();
  });

  test("a step the flow uses directly is checked too", async () => {
    const e = await env([
      def({
        name: "solo",
        steps: [{ name: "x", results: ["ok"], run: () => ({ result: "ok" }) }],
      }),
    ]);
    expect(e.registry.startProblem("job")).toBeUndefined();
    await e.log.close();
  });

  test("enabling the plugin and starting again works; the event was kept", async () => {
    const root = await tempRoot();
    const before = await env([appPlugin()], { root, disabled: ["pool"] });
    const received = await before.kernel
      .receive({ source: "cron", key: "k1", type: "tick", hops: 0 })
      .then(
        (result) => result,
        (error: unknown) => error,
      );
    expect(received).toBeInstanceOf(StartRefusedError);
    expect(await before.log.runs()).toEqual([]);
    const waiting = await listPending(before.log, before.registry, before.kernel);
    expect(waiting.map((item) => [item.kind, item.flow, item.prompt])).toEqual([
      [
        "refused",
        "job",
        'cannot start: needs "pool/agent" from plugin pool, which is disabled (operad plugin enable pool)',
      ],
    ]);

    await before.log.close();

    const after = await env([appPlugin(), poolPlugin()], { root });
    await after.kernel.recoverUnrouted();
    expect(await listPending(after.log, after.registry, after.kernel)).toEqual([]);
    const runs = await after.log.runs();
    expect(runs.map((run) => run.flow)).toEqual(["job"]);
    await after.log.close();
  });

  test("recovery leaves a run whose called step went missing, and says why", async () => {
    const root = await tempRoot();
    const first = await env([appPlugin(), poolPlugin()], { root });
    const started = await first.kernel.start({ flow: "job", object: "job:1" });
    if (started.kind !== "started") throw new Error("not started");
    await first.log.close();

    const second = await env([appPlugin()], { root, disabled: ["pool"] });
    const spawned: string[] = [];
    const lines: string[] = [];
    await serveOnce({
      log: second.log,
      registry: second.registry,
      lockRoot: second.storeRoot,
      kernel: second.kernel,
      spawnRun: (runId) => {
        spawned.push(runId);
      },
      onLog: (line) => lines.push(line),
    });
    expect(spawned).toEqual([]);
    expect(lines.join("\n")).toContain(`run ${started.runId}: cannot start: needs "pool/agent"`);

    const third = await env([appPlugin(), poolPlugin()], { root });
    const again: string[] = [];
    await serveOnce({
      log: third.log,
      registry: third.registry,
      lockRoot: third.storeRoot,
      kernel: third.kernel,
      spawnRun: (runId) => {
        again.push(runId);
      },
    });
    expect(again).toEqual([started.runId]);
    await second.log.close();
    await third.log.close();
  });
});

describe("a candidate started while its plugin is disabled", () => {
  test("stays pending with the reason, and starts after the plugin is enabled", async () => {
    const root = await tempRoot();
    const candidateRule: TriggerRule = { ...RULE, mode: "candidate" };
    const make = async (plugins: readonly PluginDefinition[], disabled: readonly string[]) => {
      const storeRoot = join(root, "store");
      const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
      const registry = new PluginRegistry(plugins, {
        home: root,
        storeRoot,
        store: new MemoryPluginStore({ root: storeRoot }),
        onLog: () => undefined,
        disabled,
      });
      const kernel = new Kernel({ log, registry, home: root, storeRoot, rules: [candidateRule] });
      return { log, registry, kernel };
    };

    const before = await make([appPlugin()], ["pool"]);
    const routed = await before.kernel.receive({ source: "cron", key: "k1", type: "tick", hops: 0 });
    if (routed.kind !== "candidate" || routed.pendingId === undefined) {
      throw new Error("not a candidate");
    }
    await expect(before.kernel.startCandidate(routed.pendingId)).rejects.toBeInstanceOf(
      StartRefusedError,
    );
    const items = await listPending(before.log, before.registry, before.kernel);
    expect(items.map((item) => item.kind)).toEqual(["candidate"]);
    await before.log.close();

    const after = await make([appPlugin(), poolPlugin()], []);
    const started = await after.kernel.startCandidate(routed.pendingId);
    expect(started.kind).toBe("started");
    await after.log.close();
  });

  test("a choice recorded before the refusal is listed with the reason", async () => {
    const root = await tempRoot();
    const storeRoot = join(root, "store");
    const open = () => openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const build = (plugins: readonly PluginDefinition[], disabled: readonly string[], log: ReturnType<typeof open>) => {
      const registry = new PluginRegistry(plugins, {
        home: root,
        storeRoot,
        store: new MemoryPluginStore({ root: storeRoot }),
        onLog: () => undefined,
        disabled,
      });
      const kernel = new Kernel({
        log,
        registry,
        home: root,
        storeRoot,
        rules: [{ ...RULE, mode: "candidate" }],
      });
      return { registry, kernel };
    };
    const log = open();
    const ready = build([appPlugin(), poolPlugin()], [], log);
    const routed = await ready.kernel.receive({ source: "cron", key: "k1", type: "tick", hops: 0 });
    if (routed.kind !== "candidate" || routed.pendingId === undefined) {
      throw new Error("not a candidate");
    }
    // The person's choice is recorded; the process died before the run existed.
    await log.recordOutcome(routed.pendingId, "resolve", {
      value: "started",
      flow: "job",
      object: "job:1",
    });
    const gone = build([appPlugin()], ["pool"], log);
    const items = await listPending(log, gone.registry, gone.kernel);
    expect(items.map((item) => [item.kind, item.prompt])).toEqual([
      [
        "refused",
        'cannot start: needs "pool/agent" from plugin pool, which is disabled (operad plugin enable pool)',
      ],
    ]);
    await log.close();
  });
});

describe("calls", () => {
  test("a name that is not plugin/step is refused at load", () => {
    expect(() => appPlugin(["pool"])).not.toThrow();
    expect(() => new PluginRegistry([appPlugin(["pool"])])).toThrow(/calls\[0\]/);
    expect(() => new PluginRegistry([appPlugin(["a/b/c"])])).toThrow(/calls\[0\]/);
    expect(() => new PluginRegistry([appPlugin(["pool/agent", "pool/agent"])])).toThrow(
      /duplicate/,
    );
  });

  test("a call the step did not declare fails in tests", async () => {
    const e = await env([appPlugin("none"), poolPlugin()]);
    await expect(
      e.registry.runStep("app/outer", {}, { runId: "r1" }),
    ).rejects.toThrow('step "app/outer": calls "pool/agent" without declaring it in calls');
    await e.log.close();
  });

  test("a declared call runs", async () => {
    const e = await env([appPlugin(), poolPlugin()]);
    const result = await e.registry.runStep("app/outer", {}, { runId: "r1" });
    expect(result.result).toBe("ok");
    await e.log.close();
  });

  test("a call a step of a harness plugin needs no declaration", async () => {
    const harness = definePlugin({
      name: "harness-x",
      kind: "harness",
      version: "0.0.1",
      steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
    });
    const caller = def({
      name: "caller",
      steps: [
        {
          name: "go",
          results: ["done"],
          run: async (ctx) => {
            const run = ctx.runStep;
            if (run === undefined) throw new Error("no host");
            return run("harness-x/agent", {}, { runId: ctx.runId });
          },
        },
      ],
    });
    const e = await env([caller, harness]);
    const result = await e.registry.runStep("caller/go", {}, { runId: "r1" });
    expect(result.result).toBe("done");
    await e.log.close();
  });

  test("a step that calls steps named by data needs no declaration, and still starts without them", async () => {
    const other = definePlugin({
      name: "named",
      kind: "domain",
      version: "0.0.1",
      steps: [{ name: "target", results: ["done"], run: () => ({ result: "done" }) }],
    });
    const caller = def({
      name: "caller",
      steps: [
        {
          name: "go",
          results: ["done"],
          callsNamedByData: true,
          run: async (ctx) => {
            const run = ctx.runStep;
            if (run === undefined) throw new Error("no host");
            return run("named/target", {}, { runId: ctx.runId });
          },
        },
      ],
    });
    const e = await env([caller, other]);
    expect((await e.registry.runStep("caller/go", {}, { runId: "r1" })).result).toBe("done");
    await e.log.close();
  });
});
