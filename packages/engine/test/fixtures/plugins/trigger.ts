import { defineFlow, definePlugin } from "../../../src/index.ts";

const one = defineFlow({
  name: "one",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "trigger/record", params: {} },
      replay: "safe",
      next: { ok: "done", failed: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const two = defineFlow({
  name: "two",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "trigger/record", params: { tag: "two" } },
      replay: "safe",
      next: { ok: "done", failed: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const emitting = defineFlow({
  name: "emitting",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "trigger/emit", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const badEmit = defineFlow({
  name: "bad-emit",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "trigger/try-bad-emit", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const asking = defineFlow({
  name: "asking",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person",
      params: { prompt: "Continue?", choices: ["yes", "no"] },
      replay: "safe",
      next: { yes: "done", no: "done", interrupted: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const failing = defineFlow({
  name: "failing",
  entry: "finish",
  steps: [
    { id: "finish", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

const cancelling = defineFlow({
  name: "cancelling",
  entry: "finish",
  steps: [
    { id: "finish", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

/** A fixture for the trigger tests. */
export default definePlugin({
  name: "trigger",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  steps: [
    {
      name: "record",
      results: ["ok", "failed"],
      run(ctx) {
        return {
          result: "ok",
          data: {
            flowParams: ctx.params,
            trigger: ctx.trigger ?? null,
          },
        };
      },
    },
    {
      name: "emit",
      results: ["ok"],
      async run(ctx) {
        await ctx.emit({
          type: "trigger.custom",
          key: "one",
          summary: "external note",
          data: { value: 1 },
        });
        return { result: "ok" };
      },
    },
    {
      name: "try-bad-emit",
      results: ["ok"],
      async run(ctx) {
        try {
          await ctx.emit({ type: "other.event", key: "bad" });
          return { result: "ok", data: { error: "none" } };
        } catch (error) {
          return {
            result: "ok",
            data: { error: error instanceof Error ? error.message : String(error) },
          };
        }
      },
    },
  ],
  flows: [one, two, emitting, badEmit, asking, failing, cancelling],
});
