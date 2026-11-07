import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineFlow, definePlugin } from "../../../src/index.ts";
import { waitForChange } from "../../../src/platform/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves when the file exists: a directory watch, re-checked on a timer. */
async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), 200);
  }
}

function mark(dir: string, name: string): void {
  const first = join(dir, `started-${name}`);
  writeFileSync(existsSync(first) ? `${first}-again` : first, String(process.pid));
}

function flow(
  name: string,
  stepParams: Record<string, unknown>,
  hold: boolean,
  replay: "safe" | "unsafe" = "safe",
) {
  return defineFlow({
    name,
    entry: "q",
    steps: [
      {
        id: "q",
        kind: "plugin",
        params: { use: "ask/question", params: stepParams },
        replay,
        next: {
          answered: hold ? "hold" : "done",
          rejected: hold ? "hold" : "done",
          waiting: "person",
          failed: "done",
          // A step that ran again after a crash ends here: the person decides.
          interrupted: replay === "unsafe" ? (hold ? "hold" : "person") : "done",
        },
      },
      ...(hold
        ? [
            {
              id: "hold",
              kind: "plugin" as const,
              params: { use: "ask/hold", params: {} },
              replay: "safe" as const,
              next: { ok: "done", failed: "done", interrupted: "done" },
            },
          ]
        : []),
      {
        id: "person",
        kind: "wait_person",
        params: { prompt: "Waiting?", choices: ["yes", "no"] },
        replay: "safe",
        next: { yes: "done", no: "done", interrupted: "done" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    ],
  });
}

/**
 * Asks what the run's params say and ends with the answer. The run's params
 * are { name, dir, prompt?, choices?, graceSecs?, onTimeout? }.
 */
export default definePlugin({
  name: "ask",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "question",
      results: ["answered", "rejected", "waiting", "failed", "interrupted"],
      async run(ctx) {
        if (!isRecord(ctx.params)) throw new Error("the flow needs params");
        const { name, dir } = ctx.params;
        if (typeof name !== "string" || typeof dir !== "string") {
          throw new Error("the flow needs { name, dir }");
        }
        mark(dir, name);
        if (ctx.params.concurrent === true) {
          // Two questions at once: the second is refused, the first goes on.
          const first = ctx.ask({ prompt: "First?", choices: ["yes", "no"] });
          let refused = "";
          try {
            await ctx.ask({ prompt: "Second?", choices: ["yes", "no"] });
          } catch (error) {
            refused = error instanceof Error ? error.message : String(error);
          }
          const answer = await first;
          return { result: "answered", data: { refused, choice: answer.choice ?? null } };
        }
        const answer = await ctx.ask({
          prompt:
            typeof ctx.params.prompt === "string"
              ? ctx.params.prompt
              : "Delete the stale branch?",
          choices: Array.isArray(ctx.params.choices)
            ? ctx.params.choices.filter((item): item is string => typeof item === "string")
            : ["yes", "no"],
          ...(typeof ctx.params.graceSecs === "number"
            ? { graceSecs: ctx.params.graceSecs }
            : {}),
          ...(ctx.params.onTimeout === "reject_once"
            ? { onTimeout: "reject_once" as const }
            : {}),
          resume: { session: "s1" },
        });
        if (answer.rejected === true) return { result: "rejected" };
        return {
          result: "answered",
          data: {
            choice: answer.choice ?? null,
            note: answer.note ?? null,
            actor: answer.actor === undefined ? null : { ...answer.actor },
          },
        };
      },
    },
    {
      // Asks with the default onTimeout but does not declare `waiting`.
      name: "bare",
      results: ["answered", "failed", "interrupted"],
      async run(ctx, params) {
        const rejectOnce = isRecord(params) && params.rejectOnce === true;
        const answer = await ctx.ask({
          prompt: "Bare?",
          ...(rejectOnce ? { onTimeout: "reject_once" as const } : {}),
        });
        return { result: "answered", data: { rejected: answer.rejected === true } };
      },
    },
    {
      name: "hold",
      results: ["ok", "failed", "interrupted"],
      async run(ctx) {
        if (!isRecord(ctx.params)) throw new Error("the flow needs params");
        const { name, dir } = ctx.params;
        if (typeof name !== "string" || typeof dir !== "string") {
          throw new Error("the flow needs { name, dir }");
        }
        writeFileSync(join(dir, `holding-${name}`), "1");
        await waitForFile(join(dir, `gate-${name}`));
        return { result: "ok" };
      },
    },
  ],
  flows: [
    flow("ask-wait", {}, false),
    flow("ask-hold", {}, true),
    flow("ask-param90", { askGraceSecs: 90 }, false),
    flow("ask-param30", { askGraceSecs: 30 }, false),
    flow("ask-unsafe", {}, false, "unsafe"),
    flow("ask-unsafe-hold", {}, true, "unsafe"),
  ],
});
