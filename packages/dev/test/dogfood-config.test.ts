/**
 * This repository's committed `.operad/dev.json` with `worker.use` switched to
 * `harness-pi/agent`, as `docs/dogfood.md` describes. The committed file is not
 * changed. No model is called and no pi login is read.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { createDevPlugin, validateDevSettings } from "../src/index.ts";
import { storeAt, tempRoot } from "./support.ts";

const CONFIG = fileURLToPath(new URL("../../../.operad/dev.json", import.meta.url));

function committed(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, unknown>;
}

async function plugin(path: string): Promise<{ readonly default: unknown }> {
  return (await import(new URL(path, import.meta.url).href)) as { readonly default: unknown };
}

describe("this repository's dev.json with the pi worker", () => {
  test("worker.use harness-pi/agent validates and the dev flow resolves it", async () => {
    const settings = validateDevSettings({
      ...committed(),
      worker: { use: "harness-pi/agent", args: [] },
    });
    expect(settings.worker.use).toBe("harness-pi/agent");

    const root = await tempRoot();
    const registry = new PluginRegistry(
      [
        createDevPlugin(),
        createShellPlugin(),
        (await plugin("../../harness-pi/src/index.ts")).default,
      ],
      { home: root, cwd: root, store: storeAt(root) },
    );
    expect(registry.refusals()).toEqual([]);
    expect(registry.flow("dev")).toBeDefined();
    // The step the switch names exists and reports what radian's step reports.
    const results = registry.stepResults(settings.worker.use);
    expect(results).toBeDefined();
    const radian = (await plugin("../../harness-radian/src/index.ts")).default;
    const withRadian = new PluginRegistry([radian], {
      home: root,
      cwd: root,
      store: storeAt(root),
    });
    expect(results).toEqual(withRadian.stepResults("harness-radian/agent") ?? []);
  });

  test("without the plugin enabled the same step name does not resolve", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([createDevPlugin(), createShellPlugin()], {
      home: root,
      cwd: root,
      store: storeAt(root),
    });
    expect(registry.stepResults("harness-pi/agent")).toBeUndefined();
  });
});

describe("this repository's dev.json with the claude worker", () => {
  test("worker.use harness-claude/agent with --model and --effort validates and the dev flow resolves it", async () => {
    const settings = validateDevSettings({
      ...committed(),
      worker: { use: "harness-claude/agent", args: ["--model", "sonnet"] },
      reviewer: {
        ...(committed().reviewer as Record<string, unknown>),
        use: "harness-claude/agent",
        args: ["--model", "opus", "--effort", "medium"],
      },
    });
    expect(settings.worker.use).toBe("harness-claude/agent");
    expect(settings.reviewer.use).toBe("harness-claude/agent");

    const root = await tempRoot();
    const registry = new PluginRegistry(
      [
        createDevPlugin(),
        createShellPlugin(),
        (await plugin("../../harness-claude/src/index.ts")).default,
      ],
      { home: root, cwd: root, store: storeAt(root) },
    );
    expect(registry.refusals()).toEqual([]);
    expect(registry.flow("dev")).toBeDefined();
    // The step reports what radian's step reports.
    const radian = (await plugin("../../harness-radian/src/index.ts")).default;
    const withRadian = new PluginRegistry([radian], { home: root, cwd: root, store: storeAt(root) });
    expect(registry.stepResults(settings.worker.use)).toEqual(
      withRadian.stepResults("harness-radian/agent") ?? [],
    );
  });
});
