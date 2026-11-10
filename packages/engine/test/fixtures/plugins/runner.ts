import { existsSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineFlow, definePlugin } from "../../../src/index.ts";

function param(params: unknown, key: string): unknown {
  return typeof params === "object" && params !== null && key in params
    ? (params as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Resolves when the file exists. A directory watch wakes it at once; a watch
 * can miss an event under load, so a look every 100 ms backs it.
 */
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (!existsSync(path)) return;
      watcher.close();
      clearInterval(timer);
      resolve();
    };
    const watcher = watch(dirname(path), check);
    watcher.on("error", check);
    const timer = setInterval(check, 100);
    check();
  });
}

const echo = defineFlow({
  name: "simple",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/echo", params: { text: "`bun test` exited 1" } },
      replay: "safe",
      next: { ok: "done", failed: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const timed = defineFlow({
  name: "timed",
  entry: "slow",
  steps: [
    {
      id: "slow",
      kind: "plugin",
      params: { use: "test/slow", params: {} },
      replay: "safe",
      next: { ok: "done", failed: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const polled = defineFlow({
  name: "polled",
  entry: "check",
  steps: [
    {
      id: "check",
      kind: "wait",
      params: { check: "test/ready" },
      replay: "safe",
      next: { ready: "done", interrupted: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const pause = defineFlow({
  name: "pause",
  entry: "pause",
  steps: [
    {
      id: "pause",
      kind: "wait",
      params: { afterSecs: 5 },
      replay: "safe",
      next: { ready: "done", interrupted: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const noisy = defineFlow({
  name: "noisy",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/noisy", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const ask = defineFlow({
  name: "ask",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "Approve this job?", choices: ["finish", "stop"] },
      replay: "safe",
      next: { finish: "done", stop: "stopped", interrupted: "stopped" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "stopped", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

const crash = defineFlow({
  name: "crash",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/block", params: {} },
      replay: "unsafe",
      next: { ok: "done", failed: "ask", interrupted: "ask" },
    },
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "The work was interrupted. Continue?", choices: ["finish", "stop"] },
      replay: "safe",
      next: { finish: "done", stop: "stopped", interrupted: "stopped" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "stopped", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

const retry = defineFlow({
  name: "retry",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/block", params: {} },
      replay: "safe",
      next: { ok: "done", failed: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const patient = defineFlow({
  name: "patient",
  entry: "wait",
  steps: [
    {
      id: "wait",
      kind: "plugin",
      params: { use: "test/patient", params: {} },
      replay: "safe",
      next: { ok: "done", failed: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const hang = defineFlow({
  name: "hang",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/hang", params: {} },
      replay: "safe",
      next: { ok: "done", failed: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const write = defineFlow({
  name: "write",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/write", params: {} },
      replay: "unsafe",
      next: { ok: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const throwing = defineFlow({
  name: "throwing",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/fragile", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const brokenCheck = defineFlow({
  name: "broken-check",
  entry: "check",
  steps: [
    {
      id: "check",
      kind: "wait",
      params: { check: "test/broken-ready" },
      replay: "safe",
      next: { ready: "done", interrupted: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const afterAsk = defineFlow({
  name: "after-ask",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "Go?", choices: ["go", "stop"] },
      replay: "safe",
      next: { go: "work", stop: "done", interrupted: "done" },
    },
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/echo", params: { text: "worked" } },
      replay: "unsafe",
      next: { ok: "done", failed: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

/** The runner fixture: one blocking step, one slow step, a noisy step and a wait. */
export default definePlugin({
  name: "test",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }, { name: "task" }, { name: "brief" }],
  actions: [
    {
      name: "approve",
      on: "job",
      when: () => true,
      async run(ctx, args) {
        const choice = typeof args === "string" ? args : "finish";
        await ctx.answer?.(choice);
      },
    },
  ],
  steps: [
    {
      name: "echo",
      results: ["ok", "failed"],
      async run(_ctx, params) {
        return {
          result: "ok",
          data: {
            reason: String(param(params, "text") ?? "worked"),
          },
        };
      },
    },
    {
      name: "slow",
      results: ["ok", "failed"],
      run() {
        return new Promise(() => undefined);
      },
    },
    {
      name: "patient",
      results: ["ok", "failed"],
      timeoutSecs: 5,
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { result: "ok" as const };
      },
    },
    {
      name: "noisy",
      results: ["ok"],
      async run(ctx) {
        const text = "x".repeat(2 * 1024 * 1024);
        const path = await ctx.logger.write(text);
        return { result: "ok", data: { log: path } };
      },
    },
    {
      name: "ready",
      results: ["ready", "waiting"],
      async run(ctx) {
        return {
          result: existsSync(join(ctx.home, "ready")) ? "ready" : "waiting",
        };
      },
    },
    {
      name: "block",
      results: ["ok", "failed", "interrupted"],
      async run(ctx) {
        writeFileSync(join(ctx.home, "blocked"), String(process.pid));
        await waitForFile(join(ctx.home, "release"));
        return { result: "ok" };
      },
    },
    {
      name: "hang",
      results: ["ok", "failed", "interrupted"],
      run() {
        let spin = 0;
        while (spin >= 0) spin += 1;
        return { result: "ok" as const };
      },
    },
    {
      name: "write",
      results: ["ok"],
      async run(ctx) {
        await ctx.store.put("job", "1", { wrote: true }, "test");
        return { result: "ok" };
      },
    },
    {
      name: "fragile",
      results: ["ok"],
      run() {
        throw new Error("boom");
      },
    },
    {
      name: "broken-ready",
      results: ["ready", "waiting"],
      run() {
        throw new Error("check boom");
      },
    },
  ],
  flows: [
    echo,
    timed,
    patient,
    polled,
    pause,
    noisy,
    ask,
    crash,
    retry,
    hang,
    write,
    throwing,
    brokenCheck,
    afterAsk,
  ],
  async onTick(ctx) {
    const flag = join(ctx.home, "tick-start");
    if (!existsSync(flag)) return;
    rmSync(flag, { force: true });
    await ctx.start("ask", { type: "job", id: "9" });
  },
  check() {
    return "ready";
  },
});
