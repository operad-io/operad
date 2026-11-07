import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineFlow, definePlugin } from "../../../src/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dirOf(params: unknown): string {
  if (!isRecord(params) || typeof params.dir !== "string") {
    throw new Error("the flow needs { dir }");
  }
  return params.dir;
}

const CALLS = ["rm -rf build", "rm -rf build", "rm -rf other"];

/**
 * A fake harness. The first time it asks whether it may run `rm -rf build`;
 * when it runs again with the answer it records what it was given and tries
 * three calls, the way a harness hook would: a call equal to a grant goes
 * through only if the grant can be used up.
 */
export default definePlugin({
  name: "resume",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "agent",
      resumable: true,
      results: ["done", "waiting", "failed", "interrupted"],
      async run(ctx, params) {
        const dir = dirOf(ctx.params);
        const given = isRecord(params) ? params : {};
        if (given.askAnswer === undefined) {
          writeFileSync(join(dir, "first-params.json"), JSON.stringify(given));
          await ctx.ask({
            prompt: "Run rm -rf build?",
            choices: ["yes", "no"],
            resume: {
              session: "sess-1",
              grant: { kind: "command", value: "rm -rf build", choice: "yes" },
            },
          });
          return { result: "done" };
        }
        const grants =
          isRecord(ctx.access) && Array.isArray(ctx.access.grants)
            ? (ctx.access.grants as unknown[]).filter(isRecord)
            : [];
        const outcomes: string[] = [];
        for (const command of CALLS) {
          const grant = grants.find((item) => item.value === command);
          if (
            grant !== undefined &&
            typeof grant.waitId === "string" &&
            (await ctx.useGrant(grant.waitId))
          ) {
            outcomes.push("granted");
            writeFileSync(join(dir, "granted-call"), command);
          } else {
            outcomes.push("refused");
          }
        }
        const seen = {
          resumeSession: given.resumeSession ?? null,
          askAnswer: given.askAnswer,
          grants,
          outcomes,
        };
        writeFileSync(join(dir, "second-run.json"), JSON.stringify(seen));
        return { result: "done", data: { outcomes } };
      },
    },
    {
      // Cannot run again from where it left: its question gets one answer or none.
      name: "plain",
      resumable: false,
      results: ["done", "failed", "interrupted"],
      async run(ctx) {
        const answer = await ctx.ask({
          prompt: "Plain?",
          choices: ["yes", "no"],
          onTimeout: "waiting",
          graceSecs: 0,
        });
        return { result: "done", data: { rejected: answer.rejected === true } };
      },
    },
  ],
  flows: [
    defineFlow({
      name: "resume-flow",
      entry: "agent",
      steps: [
        {
          id: "agent",
          kind: "plugin",
          params: { use: "resume/agent", params: {} },
          replay: "safe",
          next: { done: "done", waiting: "person", failed: "done", interrupted: "done" },
        },
        {
          id: "person",
          kind: "wait_person",
          params: { prompt: "Waiting?", choices: ["yes", "no"] },
          replay: "safe",
          next: { yes: "agent", no: "done", interrupted: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
    defineFlow({
      name: "plain-flow",
      entry: "plain",
      steps: [
        {
          id: "plain",
          kind: "plugin",
          params: { use: "resume/plain", params: {} },
          replay: "safe",
          next: { done: "done", failed: "done", interrupted: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
  ],
});
