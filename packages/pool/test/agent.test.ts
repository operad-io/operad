import { afterAll, describe, expect, test } from "bun:test";
import { PluginRegistry, MemoryPluginStore, type PluginStepResult } from "@operad-io/engine";
import { PlaceBook, createPoolPlugin, modelUnavailable } from "../src/index.ts";
import { Queue, cleanupTempRoots, done, rig, tempRoot, worker, type HarnessCall } from "./support.ts";
import { join } from "node:path";

afterAll(cleanupTempRoots);

const PREFIX = "repo/default";

function params(
  workers: ReturnType<typeof worker>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { prompt: "do it", cwd: "/work", prefix: PREFIX, workers, ...extra };
}

const a = worker("a", "harness-a/agent", { args: ["--model", "m1"], wallTimeSecs: 30, stallSecs: 5 });
const b = worker("b", "harness-b/agent");

describe("picking", () => {
  test("takes the first worker in order that has room, and says which ran", async () => {
    const r = await rig();
    const first = r.run(params([a, b]));
    const call = await r.calls.next();
    expect(call.use).toBe("harness-a/agent");
    expect(call.params).toEqual({
      prompt: "do it",
      cwd: "/work",
      args: ["--model", "m1"],
      wallTimeSecs: 30,
      stallSecs: 5,
    });
    call.finish({ result: "done", data: { cost: 1 } });
    const result = await first;
    expect(result).toEqual({
      result: "done",
      data: { cost: 1, worker: "a", harness: "harness-a" },
    });
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(0);
  });

  test("a busy first worker passes the run to the next one", async () => {
    const r = await rig();
    const one = r.run(params([a, b]));
    const callOne = await r.calls.next();
    const two = r.run(params([a, b]));
    const callTwo = await r.calls.next();
    expect([callOne.use, callTwo.use]).toEqual(["harness-a/agent", "harness-b/agent"]);
    callOne.finish(done);
    callTwo.finish(done);
    expect((await two).data?.worker).toBe("b");
    expect((await one).data?.worker).toBe("a");
  });

  test("the flow's count of a worker above 1 lets that many run", async () => {
    const r = await rig();
    const wide = worker("a", "harness-a/agent", { count: 2 });
    const runs = [r.run(params([wide])), r.run(params([wide]))];
    const calls = [await r.calls.next(), await r.calls.next()];
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(2);
    for (const call of calls) call.finish(done);
    await Promise.all(runs);
  });

  test("counts are per key prefix: another repository has its own", async () => {
    const r = await rig();
    const one = r.run(params([a]));
    const two = r.run(params([a], { prefix: "other/default" }));
    const calls = [await r.calls.next(), await r.calls.next()];
    for (const call of calls) call.finish(done);
    await Promise.all([one, two]);
  });

  test("with worker set only that worker may run, even when another has room", async () => {
    const r = await rig();
    const holder = r.run(params([a, b]));
    const held = await r.calls.next();
    const pinned = r.run(params([a, b], { worker: "a" }));
    const waiting = await r.events.next();
    expect(waiting.type).toBe("pool.waiting");
    expect(r.calls.length).toBe(0);
    held.finish(done);
    const call = await r.calls.next();
    expect(call.use).toBe("harness-a/agent");
    call.finish(done);
    expect((await pinned).data?.worker).toBe("a");
    await holder;
  });

  test("a worker that is not in the definitions fails at once", async () => {
    const r = await rig();
    const result = await r.run(params([a, b], { worker: "gone" }));
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("unknown_worker");
    expect(String(result.data?.message)).toContain('"gone"');
    expect(r.calls.length).toBe(0);
  });

  test("bad params are refused with the field", async () => {
    const r = await rig();
    await expect(r.run({ prompt: "x", workers: [a] })).rejects.toThrow("params.prefix");
    await expect(r.run(params([a], { workers: [{ name: "a", use: "h/agent", count: 0 }] }))).rejects.toThrow(
      "params.workers[0].count",
    );
    await expect(r.run(params([a], { workers: [] }))).rejects.toThrow("at least one worker");
  });
});

describe("the home cap", () => {
  test("two workers of one harness share its cap, and the wait says the home is full", async () => {
    const r = await rig({ harnesses: { "harness-a": 1 } });
    const flash = worker("flash", "harness-a/agent");
    const pro = worker("pro", "harness-a/agent");
    const one = r.run(params([flash, pro]));
    const held = await r.calls.next();
    const two = r.run(params([flash, pro]));
    const event = await r.events.next();
    expect(event.data).toMatchObject({ pool: PREFIX, full: "home" });
    expect(event.summary).toContain(PREFIX);
    expect(event.summary).toContain("home");
    expect(r.calls.length).toBe(0);
    held.finish(done);
    const next = await r.calls.next();
    expect(next.use).toBe("harness-a/agent");
    expect(r.book.used("harness:harness-a")).toBe(1);
    next.finish(done);
    await Promise.all([one, two]);
    expect(r.book.used("harness:harness-a")).toBe(0);
  });

  test("a full cap on one harness sends the run to a worker of another", async () => {
    const r = await rig({ harnesses: { "harness-a": 1 } });
    const one = r.run(params([a, b]));
    const held = await r.calls.next();
    const two = r.run(params([a, b]));
    const call = await r.calls.next();
    expect(call.use).toBe("harness-b/agent");
    call.finish(done);
    held.finish(done);
    await Promise.all([one, two]);
  });

  test("a harness with no cap is not limited by one", async () => {
    const r = await rig({ harnesses: { "harness-b": 1 } });
    const wide = worker("a", "harness-a/agent", { count: 3 });
    const runs = [r.run(params([wide])), r.run(params([wide])), r.run(params([wide]))];
    const calls = [await r.calls.next(), await r.calls.next(), await r.calls.next()];
    for (const call of calls) call.finish(done);
    await Promise.all(runs);
  });

  test("the cap counts across flows (different prefixes)", async () => {
    const r = await rig({ harnesses: { "harness-a": 1 } });
    const one = r.run(params([a]));
    const held = await r.calls.next();
    const two = r.run(params([a], { prefix: "other/default" }));
    expect((await r.events.next()).data).toMatchObject({ full: "home" });
    held.finish(done);
    (await r.calls.next()).finish(done);
    await Promise.all([one, two]);
  });

  test("a settings change: running steps keep their place, the next start uses the new cap", async () => {
    const calls = new Queue<HarnessCall>();
    const book = new PlaceBook();
    const before = await rig({ harnesses: { "harness-a": 1 } }, { book, calls });
    const after = await rig({ harnesses: { "harness-a": 2 } }, { book, calls });
    const wide = worker("a", "harness-a/agent", { count: 5 });

    const one = before.run(params([wide]));
    const held = await calls.next();
    const blocked = before.run(params([wide]));
    await before.events.next();
    expect(calls.length).toBe(0);

    const two = after.run(params([wide]));
    const second = await calls.next();
    expect(book.used("harness:harness-a")).toBe(2);
    second.finish(done);
    held.finish(done);
    (await calls.next()).finish(done);
    await Promise.all([one, two, blocked]);
    expect(book.used("harness:harness-a")).toBe(0);
  });
});

describe("waiting", () => {
  test("a full flow count is reported as the flow's", async () => {
    const r = await rig();
    const one = r.run(params([a]));
    const held = await r.calls.next();
    const two = r.run(params([a]));
    const event = await r.events.next();
    expect(event.type).toBe("pool.waiting");
    expect(event.data).toMatchObject({ pool: PREFIX, full: "flow" });
    expect(event.summary).toContain("flow");
    held.finish(done);
    (await r.calls.next()).finish(done);
    await Promise.all([one, two]);
  });

  test("one event per reason while waiting, not one per wake-up", async () => {
    const r = await rig();
    const one = r.run(params([a]));
    const first = await r.calls.next();
    const two = r.run(params([a]));
    const three = r.run(params([a]));
    await r.events.next();
    await r.events.next();
    first.finish(done);
    const second = await r.calls.next();
    // The third run woke up, found the place taken, and kept waiting silently.
    second.finish(done);
    (await r.calls.next()).finish(done);
    await Promise.all([one, two, three]);
    // Only the two that waited say they got a place; none says it waits again.
    expect(r.events.length).toBe(2);
    expect((await r.events.next()).type).toBe("pool.acquired");
    expect((await r.events.next()).type).toBe("pool.acquired");
  });

  test("the wait names who holds the place, and the end of the wait is announced", async () => {
    const r = await rig();
    const one = r.run({ ...params([a]), holder: "T-0001" });
    const held = await r.calls.next();
    expect(held.params.holder).toBeUndefined();
    const two = r.run({ ...params([a]), holder: "T-0002" });
    const waiting = await r.events.next();
    expect(waiting.type).toBe("pool.waiting");
    expect(waiting.data).toMatchObject({ workers: [{ worker: "a", holders: ["T-0001"] }] });
    held.finish(done);
    (await r.calls.next()).finish(done);
    await Promise.all([one, two]);
    expect((await r.events.next()).type).toBe("pool.acquired");
  });

  test("an abort while waiting ends the step as interrupted and holds nothing", async () => {
    const r = await rig();
    const one = r.run(params([a]));
    const held = await r.calls.next();
    const controller = new AbortController();
    const two = r.run(params([a]), controller.signal);
    await r.events.next();
    await r.book.whenWaiting(1);
    controller.abort();
    const result = await two;
    expect(result.result).toBe("interrupted");
    expect(r.book.waiting()).toBe(0);
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(1);
    held.finish(done);
    await one;
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(0);
    expect(r.book.used("harness:harness-a")).toBe(0);
    expect(r.calls.length).toBe(0);
  });

  test("a place freed while the waiting event is being sent is not missed", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const r = await rig({}, undefined, gate);
    const one = r.run(params([a]));
    const held = await r.calls.next();
    const two = r.run(params([a]));
    // The second run is inside its event; the first ends before the event is out.
    held.finish(done);
    await one;
    open();
    (await r.calls.next()).finish(done);
    await two;
  });

  test("an abort before the step starts holds nothing", async () => {
    const r = await rig();
    const controller = new AbortController();
    controller.abort();
    const result = await r.run(params([a]), controller.signal);
    expect(result.result).toBe("interrupted");
    expect(r.calls.length).toBe(0);
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(0);
  });

  test("a throw from the harness step releases the place and reaches the caller", async () => {
    const r = await rig({ harnesses: { "harness-a": 1 } });
    const one = r.run(params([a]));
    (await r.calls.next()).fail(new Error("cannot start"));
    await expect(one).rejects.toThrow("cannot start");
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(0);
    expect(r.book.used("harness:harness-a")).toBe(0);
    const two = r.run(params([a]));
    (await r.calls.next()).finish(done);
    await two;
  });

  test("a harness result that is a failure releases the place too", async () => {
    const r = await rig();
    const one = r.run(params([a]));
    (await r.calls.next()).finish({ result: "failed", data: { reason: "timeout" } });
    expect((await one).result).toBe("failed");
    expect(r.book.used(`count:${PREFIX}/a`)).toBe(0);
  });
});

describe("fallback", () => {
  const usage: PluginStepResult = {
    result: "failed",
    data: { modelError: { kind: "usage_limit" }, message: "limit" },
  };
  const claude = worker("claude", "harness-a/agent", { fallback: "pi" });
  const pi = worker("pi", "harness-b/agent", { args: ["--model", "flash"] });

  for (const kind of ["unavailable", "usage_limit"]) {
    test(`a ${kind} model error runs the fallback worker and records it`, async () => {
      const r = await rig();
      const run = r.run(params([claude, pi], { worker: "claude" }));
      (await r.calls.next()).finish({ result: "failed", data: { modelError: { kind } } });
      const call = await r.calls.next();
      expect(call.use).toBe("harness-b/agent");
      expect(call.params.args).toEqual(["--model", "flash"]);
      call.finish({ result: "done", data: { cost: 2 } });
      expect(await run).toEqual({
        result: "done",
        data: { cost: 2, worker: "pi", harness: "harness-b", fallbackFrom: "claude" },
      });
    });
  }

  for (const reason of ["missing", "spawn"]) {
    test(`a harness that could not start (${reason}) runs the fallback worker`, async () => {
      const r = await rig();
      const run = r.run(params([claude, pi]));
      (await r.calls.next()).finish({ result: "failed", data: { reason, message: "no program" } });
      const call = await r.calls.next();
      expect(call.use).toBe("harness-b/agent");
      call.finish(done);
      expect((await run).data).toMatchObject({ worker: "pi", fallbackFrom: "claude" });
    });
  }

  test("the fallback does not receive the requested worker's resume session", async () => {
    const r = await rig();
    const run = r.run(params([claude, pi], { worker: "claude", resumeSession: "claude-session" }));
    const first = await r.calls.next();
    expect(first.params.resumeSession).toBe("claude-session");
    first.finish(usage);
    const call = await r.calls.next();
    expect(call.use).toBe("harness-b/agent");
    expect("resumeSession" in call.params).toBe(false);
    call.finish(done);
    await run;
  });

  test("the fallback may be a worker outside the pool", async () => {
    const r = await rig();
    const run = r.run(params([claude], { fallbacks: [pi] }));
    (await r.calls.next()).finish(usage);
    const call = await r.calls.next();
    expect(call.use).toBe("harness-b/agent");
    call.finish(done);
    expect((await run).data?.fallbackFrom).toBe("claude");
  });

  test("a fallback named nowhere in the definitions is a clear failure", async () => {
    const r = await rig();
    const run = r.run(params([claude]));
    (await r.calls.next()).finish(usage);
    const result = await run;
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("unknown_fallback");
    expect(r.book.used(`count:${PREFIX}/claude`)).toBe(0);
  });

  test("a throw before the harness starts runs the fallback", async () => {
    const r = await rig();
    const run = r.run(params([claude, pi]));
    (await r.calls.next()).fail(new Error("no such program"));
    const call = await r.calls.next();
    call.finish(done);
    const result = await run;
    expect(result.data).toMatchObject({ worker: "pi", fallbackFrom: "claude" });
  });

  test("a timeout never falls back", async () => {
    const r = await rig();
    const run = r.run(params([claude, pi]));
    (await r.calls.next()).finish({ result: "failed", data: { reason: "timeout", message: "wall time" } });
    const result = await run;
    expect(result.data).toMatchObject({ reason: "timeout", worker: "claude", harness: "harness-a" });
    expect(result.data?.fallbackFrom).toBeUndefined();
    expect(r.calls.length).toBe(0);
  });

  test("a model error of another kind, or a worker without a fallback, does not fall back", async () => {
    const r = await rig();
    const run = r.run(params([claude, pi]));
    (await r.calls.next()).finish({ result: "failed", data: { modelError: { kind: "rate_limited" } } });
    expect((await run).data?.worker).toBe("claude");
    const plain = r.run(params([a, pi]));
    (await r.calls.next()).finish(usage);
    const result = await plain;
    expect(result.data).toMatchObject({ worker: "a" });
    expect(r.calls.length).toBe(0);
  });

  test("a thrown error without a fallback reaches the caller", async () => {
    const r = await rig();
    const run = r.run(params([a]));
    (await r.calls.next()).fail(new Error("boom"));
    await expect(run).rejects.toThrow("boom");
  });

  test("the fallback's own failure is returned as it is, with no second fallback", async () => {
    const r = await rig();
    const again = worker("pi", "harness-b/agent");
    const run = r.run(params([claude, again]));
    (await r.calls.next()).finish(usage);
    (await r.calls.next()).finish(usage);
    const result = await run;
    expect(result.result).toBe("failed");
    expect(result.data).toMatchObject({ modelError: { kind: "usage_limit" }, worker: "pi", fallbackFrom: "claude" });
    expect(r.calls.length).toBe(0);
  });

  test("a busy fallback is waited for, and the first worker's place is released meanwhile", async () => {
    const r = await rig({ harnesses: { "harness-a": 1 } });
    const busy = r.run(params([pi], { worker: "pi" }));
    const held = await r.calls.next();
    const run = r.run(params([claude], { fallbacks: [pi] }));
    (await r.calls.next()).finish(usage);
    const event = await r.events.next();
    expect(event.data).toMatchObject({ full: "flow" });
    // The original worker gave up its places before the wait.
    expect(r.book.used(`count:${PREFIX}/claude`)).toBe(0);
    expect(r.book.used("harness:harness-a")).toBe(0);
    held.finish(done);
    (await r.calls.next()).finish(done);
    const result = await run;
    expect(result.data).toMatchObject({ worker: "pi", fallbackFrom: "claude" });
    await busy;
  });

  test("an abort while waiting for the fallback ends interrupted with nothing held", async () => {
    const r = await rig();
    const busy = r.run(params([pi], { worker: "pi" }));
    const held = await r.calls.next();
    const controller = new AbortController();
    const run = r.run(params([claude], { fallbacks: [pi] }), controller.signal);
    (await r.calls.next()).finish(usage);
    await r.events.next();
    await r.book.whenWaiting(1);
    controller.abort();
    expect((await run).result).toBe("interrupted");
    held.finish(done);
    await busy;
    expect(r.book.used(`count:${PREFIX}/pi`)).toBe(0);
  });
});

describe("modelUnavailable", () => {
  test("reads the kind only", () => {
    expect(modelUnavailable({ modelError: { kind: "unavailable" } })).toBe(true);
    expect(modelUnavailable({ modelError: { kind: "usage_limit" } })).toBe(true);
    expect(modelUnavailable({ modelError: { kind: "other" } })).toBe(false);
    expect(modelUnavailable({ modelError: "unavailable" })).toBe(false);
    expect(modelUnavailable(undefined)).toBe(false);
  });
});

describe("settings", () => {
  async function load(section: unknown) {
    const root = await tempRoot();
    const logs: string[] = [];
    const registry = new PluginRegistry([createPoolPlugin()], {
      home: join(root, "home"),
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      settings: { pool: section },
      onLog: (message) => logs.push(message),
    });
    return { registry, logs: logs.join("\n") };
  }

  test("harnesses defaults to {} and accepts counts", async () => {
    expect((await load({})).registry.names()).toEqual(["pool"]);
    expect((await load({ harnesses: { "pi": 2 } })).registry.names()).toEqual(["pool"]);
  });

  for (const bad of [0, -1, 1.5, "2", null]) {
    test(`refuses ${JSON.stringify(bad)} with the field path`, async () => {
      const loaded = await load({ harnesses: { "pi": bad } });
      expect(loaded.registry.names()).toEqual([]);
      expect(loaded.logs).toContain("settings.harnesses");
      expect(loaded.logs).toContain("pi");
    });
  }

  test("refuses harnesses that is not an object", async () => {
    const loaded = await load({ harnesses: 3 });
    expect(loaded.registry.names()).toEqual([]);
    expect(loaded.logs).toContain("settings.harnesses");
  });
});
