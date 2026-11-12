import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "../../../src/index.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The steps the step-worker tests drive through a fake parent port. */
export default definePlugin({
  name: "worker",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "echo",
      results: ["ok"],
      run(_ctx, params) {
        return { result: "ok", data: { params } };
      },
    },
    {
      name: "write",
      results: ["ok"],
      async run(ctx) {
        await ctx.store.put("thing", "1", { wrote: true }, "test");
        return { result: "ok" };
      },
    },
    {
      name: "emit",
      results: ["ok", "failed"],
      async run(ctx) {
        try {
          await ctx.emit({
            type: "worker.event",
            key: "step-worker-test",
            data: { hello: "world" },
          });
          return { result: "ok" };
        } catch (error) {
          return { result: "failed", data: { error: messageOf(error) } };
        }
      },
    },
    {
      name: "ask",
      results: ["answered", "waiting", "failed"],
      async run(ctx) {
        try {
          const answer = await ctx.ask({
            prompt: "Go?",
            choices: ["yes", "no"],
            graceSecs: 5,
          });
          return { result: "answered", data: { choice: answer.choice ?? null } };
        } catch (error) {
          return { result: "failed", data: { error: messageOf(error) } };
        }
      },
    },
    {
      name: "grant",
      results: ["ok", "failed"],
      async run(ctx) {
        try {
          return { result: "ok", data: { used: await ctx.useGrant("w1") } };
        } catch (error) {
          return { result: "failed", data: { error: messageOf(error) } };
        }
      },
    },
    {
      name: "report",
      results: ["ok", "failed"],
      async run(ctx) {
        try {
          const end = await ctx.queued?.("place", 3);
          await end?.();
          return { result: "ok" };
        } catch (error) {
          return { result: "failed", data: { error: messageOf(error) } };
        }
      },
    },
    {
      name: "hold",
      results: ["ok"],
      limit: {
        key: () => "key",
        concurrent: () => 1,
      },
      run() {
        return { result: "ok" };
      },
    },
    {
      name: "outer",
      calls: ["worker/hold"],
      results: ["ok", "failed"],
      async run(ctx) {
        const run = ctx.runStep;
        if (run === undefined) throw new Error("no host");
        try {
          return await run("worker/hold", {}, {
            runId: ctx.runId,
            signal: ctx.signal,
            params: ctx.params,
          });
        } catch (error) {
          return { result: "failed", data: { error: messageOf(error) } };
        }
      },
    },
    {
      name: "abort",
      results: ["ok", "failed"],
      async run(ctx) {
        writeFileSync(join(ctx.home, "step-worker-abort"), "started");
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { result: "ok", data: { aborted: ctx.signal.aborted } };
      },
    },
  ],
});
