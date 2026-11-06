import { defineFlow, definePlugin } from "../../../src/index.ts";

const one = defineFlow({
  name: "plugin-one",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "rules-fixture/record", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

const two = defineFlow({
  name: "plugin-two",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "rules-fixture/record", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

/** A fixture that ships default trigger rules. */
export default definePlugin({
  name: "rules-fixture",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "record",
      results: ["ok"],
      run() {
        return { result: "ok" };
      },
    },
  ],
  flows: [one, two],
  rules: [
    {
      source: "cron",
      type: "tick",
      start: { flow: "plugin-one" },
      object: "job:1",
      mode: "auto",
    },
    {
      source: "manual",
      type: "go",
      start: { flow: "plugin-two" },
      object: "$event.object",
      mode: "auto",
    },
  ],
});
