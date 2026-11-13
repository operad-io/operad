/**
 * This repository's committed `.operad/dev.json` with `worker.use` switched to
 * `pi/agent` (or `claude/agent`), as the worker sections of `docs/user/dev.md`
 * describe. The committed file is not changed. No model is called and no pi login is read.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { createDevPlugin, validateDevSettings } from "../src/index.ts";
import { storeAt, tempRoot } from "./support.ts";

const CONFIG = fileURLToPath(new URL("../../../.operad/dev.json", import.meta.url));

function file(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, unknown>;
}

/**
 * The committed file without its `workers` and `pools`, so a test can switch to
 * the old single `worker` form (a file may not hold both).
 */
function committed(): Record<string, unknown> {
  const { workers: _workers, pools: _pools, ...rest } = file();
  return rest;
}

describe("this repository's committed dev.json", () => {
  test("validates as it is, with its workers in the default pool", () => {
    const settings = validateDevSettings(file());
    const names = settings.workers?.workers.map((worker) => worker.name) ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect(settings.workers?.pools.default).toEqual(names);
  });
});

async function plugin(path: string): Promise<{ readonly default: unknown }> {
  return (await import(new URL(path, import.meta.url).href)) as { readonly default: unknown };
}

describe("this repository's dev.json with the pi worker", () => {
  test("worker.use pi/agent validates and the dev flow resolves it", async () => {
    const settings = validateDevSettings({
      ...committed(),
      worker: { use: "pi/agent", args: [] },
    });
    expect(settings.worker.use).toBe("pi/agent");

    const root = await tempRoot();
    const registry = new PluginRegistry(
      [
        createDevPlugin(),
        createShellPlugin(),
        (await plugin("../../harness/pi/src/index.ts")).default,
      ],
      { home: root, cwd: root, store: storeAt(root) },
    );
    expect(registry.refusals()).toEqual([]);
    expect(registry.flow("dev")).toBeDefined();
    // The step the switch names exists and reports what radian's step reports,
    // plus `waiting`: a question about a call that ran out of grace. radian is
    // the degraded harness and never waits for a late answer.
    const results = registry.stepResults(settings.worker.use);
    expect(results).toBeDefined();
    const radian = (await plugin("../../harness/radian/src/index.ts")).default;
    const withRadian = new PluginRegistry([radian], {
      home: root,
      cwd: root,
      store: storeAt(root),
    });
    expect(results).toEqual([...(withRadian.stepResults("radian/agent") ?? []), "waiting"]);
  });

  test("without the plugin enabled the same step name does not resolve", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([createDevPlugin(), createShellPlugin()], {
      home: root,
      cwd: root,
      store: storeAt(root),
    });
    expect(registry.stepResults("pi/agent")).toBeUndefined();
  });
});

describe("this repository's dev.json with the claude worker", () => {
  test("worker.use claude/agent with --model and --effort validates and the dev flow resolves it", async () => {
    const settings = validateDevSettings({
      ...committed(),
      worker: { use: "claude/agent", args: ["--model", "sonnet"] },
      reviewer: {
        ...(committed().reviewer as Record<string, unknown>),
        use: "claude/agent",
        args: ["--model", "opus", "--effort", "medium"],
      },
    });
    expect(settings.worker.use).toBe("claude/agent");
    expect(settings.reviewer.use).toBe("claude/agent");

    const root = await tempRoot();
    const registry = new PluginRegistry(
      [
        createDevPlugin(),
        createShellPlugin(),
        (await plugin("../../harness/claude/src/index.ts")).default,
      ],
      { home: root, cwd: root, store: storeAt(root) },
    );
    expect(registry.refusals()).toEqual([]);
    expect(registry.flow("dev")).toBeDefined();
    // The step reports what radian's step reports, plus `waiting`.
    const radian = (await plugin("../../harness/radian/src/index.ts")).default;
    const withRadian = new PluginRegistry([radian], { home: root, cwd: root, store: storeAt(root) });
    expect(registry.stepResults(settings.worker.use)).toEqual([
      ...(withRadian.stepResults("radian/agent") ?? []),
      "waiting",
    ]);
  });
});
