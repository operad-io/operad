import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineFlow, definePlugin } from "../../../src/index.ts";
import { waitForChange } from "../../../src/platform/index.ts";
import { isRecord } from "../../../src/util.ts";

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
        params: {
          prompt: "Waiting?",
          choices: ["yes", "no"],
          choiceInfo: {
            yes: { label: "Yes", hint: "Go ahead.", role: "primary" },
            no: { label: "No", hint: "Stop here.", role: "destructive" },
          },
        },
        replay: "safe",
        next: { yes: "done", no: "done", interrupted: "done" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    ],
  });
}

function lateFlow(name: string) {
  return defineFlow({
    name,
    entry: "q",
    steps: [
      {
        id: "q",
        kind: "plugin",
        params: { use: "ask/question", params: {} },
        replay: "safe",
        next: {
          answered: "done",
          rejected: "done",
          waiting: "person",
          failed: "done",
          interrupted: "done",
        },
      },
      {
        // The late answer sends the run back to the step that asked.
        id: "person",
        kind: "wait_person",
        params: { prompt: "Waiting?", choices: ["yes", "no"] },
        replay: "safe",
        next: { yes: "q", no: "q", interrupted: "done" },
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
      async run(ctx, params) {
        // A step that ran again after its question was answered gets the answer
        // as `askAnswer`; this fixture reports it instead of asking again.
        if (isRecord(params) && isRecord(params.askAnswer)) {
          return { result: "answered", data: { late: params.askAnswer } };
        }
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
            Array.isArray(ctx.params.questions)
              ? ctx.params.questions
                  .map((question) =>
                    isRecord(question) && typeof question.text === "string" ? question.text : "",
                  )
                  .join("\n\n")
              : typeof ctx.params.prompt === "string"
                ? ctx.params.prompt
                : "Delete the stale branch?",
          ...(Array.isArray(ctx.params.questions)
            ? {
                questions: ctx.params.questions as never,
                ...(ctx.params.withOwnChoices === true ? { choices: ["yes", "no"] } : {}),
              }
            : {
                choices: Array.isArray(ctx.params.choices)
                  ? ctx.params.choices.filter((item): item is string => typeof item === "string")
                  : ["yes", "no"],
              }),
          ...(isRecord(ctx.params.choiceInfo)
            ? {
                choiceInfo: ctx.params.choiceInfo as Readonly<
                  Record<string, { label?: string; hint?: string; role?: "primary" | "destructive"; note?: "optional" | "required" }>
                >,
              }
            : {}),
          ...(typeof ctx.params.graceSecs === "number"
            ? { graceSecs: ctx.params.graceSecs }
            : {}),
          ...(ctx.params.onTimeout === "reject_once"
            ? { onTimeout: "reject_once" as const }
            : {}),
          ...(ctx.params.recheck === "no"
            ? {
                recheck: () => ({
                  ask: false as const,
                  note: "Full access",
                  actor: { via: "cli", id: "me" },
                }),
              }
            : {}),
          resume: { session: "s1" },
        });
        if (answer.rejected === true) return { result: "rejected" };
        return {
          result: "answered",
          data: {
            choice: answer.choice ?? null,
            note: answer.note ?? null,
            ...(answer.answers === undefined ? {} : { answers: [...answer.answers] }),
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
    lateFlow("ask-form-late"),
  ],
});
