import { defineFlow, definePlugin } from "../../../src/index.ts";

/** Module state: a step run in a worker starts from a fresh module every time. */
let calls = 0;

function flow(name: string, uses: readonly string[]) {
  return defineFlow({
    name,
    entry: "s0",
    steps: [
      ...uses.map((use, index) => ({
        id: `s${index}`,
        kind: "plugin" as const,
        params: { use, params: {} },
        replay: "safe" as const,
        next: { ok: index + 1 < uses.length ? `s${index + 1}` : "done", failed: "failed" },
      })),
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
    ],
  });
}

export default definePlugin({
  name: "iso",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "count",
      results: ["ok", "failed"],
      run: () => {
        calls += 1;
        return { result: "ok", data: { calls } };
      },
    },
    {
      name: "clone",
      results: ["ok", "failed"],
      // A function cannot be handed back from a worker.
      run: () => ({ result: "ok", data: { later: () => 1 } as never }),
    },
    {
      name: "stuck",
      results: ["ok", "failed", "interrupted"],
      run: () => new Promise(() => undefined),
    },
  ],
  flows: [
    flow("twice", ["iso/count", "iso/count"]),
    flow("clone", ["iso/clone"]),
    defineFlow({
      name: "stuck",
      entry: "work",
      steps: [
        {
          id: "work",
          kind: "plugin",
          params: { use: "iso/stuck", params: {} },
          replay: "safe",
          next: { ok: "done", failed: "done", interrupted: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
  ],
});
