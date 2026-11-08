import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineFlow, definePlugin } from "../../../src/index.ts";
import { waitForChange } from "../../../src/platform/index.ts";

interface Info {
  readonly name: string;
  readonly dir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function infoOf(params: unknown): Info {
  if (!isRecord(params) || typeof params.name !== "string" || typeof params.dir !== "string") {
    throw new Error("the flow needs { name, dir }");
  }
  return { name: params.name, dir: params.dir };
}

/** Resolves when the file exists: a directory watch, re-checked on a timer. */
async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), 200);
  }
}

function flow(
  name: string,
  use: string,
  params: Record<string, unknown>,
  replay: "safe" | "unsafe" = "safe",
) {
  return defineFlow({
    name,
    entry: "work",
    steps: [
      {
        id: "work",
        kind: "plugin",
        params: { use, params },
        replay,
        next: { ok: "done", failed: "done", interrupted: "done" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    ],
  });
}

/** Starts, records its start, and holds until its gate file exists. */
export default definePlugin({
  name: "lim",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "hold",
      results: ["ok", "failed", "interrupted"],
      limit: {
        key: (params) =>
          isRecord(params) && typeof params.key === "string" ? params.key : undefined,
        concurrent: (params) =>
          isRecord(params) && typeof params.concurrent === "number"
            ? params.concurrent
            : 1,
      },
      async run(ctx) {
        const info = infoOf(ctx.params);
        const first = join(info.dir, `started-${info.name}`);
        writeFileSync(existsSync(first) ? `${first}-again` : first, String(process.pid));
        appendFileSync(join(info.dir, "order"), `${info.name}\n`);
        await waitForFile(join(info.dir, `gate-${info.name}`));
        return { result: "ok" };
      },
    },
    {
      name: "outer",
      calls: ["lim/hold"],
      results: ["ok", "failed", "interrupted"],
      async run(ctx, params) {
        const run = ctx.runStep;
        if (run === undefined || !isRecord(params)) throw new Error("no host");
        return run("lim/hold", params.inner, { runId: ctx.runId, signal: ctx.signal, params: ctx.params });
      },
    },
  ],
  flows: [
    flow("lim-a1", "lim/hold", { key: "a", concurrent: 1 }),
    flow("lim-a2", "lim/hold", { key: "a", concurrent: 2 }),
    flow("lim-b1", "lim/hold", { key: "b", concurrent: 1 }),
    flow("lim-free", "lim/hold", {}),
    flow("lim-a1-unsafe", "lim/hold", { key: "a", concurrent: 1 }, "unsafe"),
    flow("lim-nested", "lim/outer", { inner: { key: "a", concurrent: 1 } }),
  ],
});
