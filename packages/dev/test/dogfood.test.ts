import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "@operad-io/engine";
import { createDevPlugin, validateDevSettings } from "../src/index.ts";

/**
 * The repository's own settings are the ones a task in this repository runs
 * under. The pi dogfood switch changes one field, `worker.use`; the rest of the
 * file must keep parsing and the `dev` flow must still load.
 */
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const DEV_JSON = fileURLToPath(new URL("../../../.operad/dev.json", import.meta.url));

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${at}: must be an object`);
  }
  return value as Record<string, unknown>;
}

describe("this repository's dogfood settings", () => {
  test("the dev flow validates with harness-pi/agent as the worker", () => {
    const document = record(
      JSON.parse(readFileSync(DEV_JSON, "utf8")),
      DEV_JSON,
    );
    const worker = record(document.worker, "worker");

    const settings = validateDevSettings({
      ...document,
      worker: { ...worker, use: "harness-pi/agent", args: [] },
    });
    expect(settings.worker.use).toBe("harness-pi/agent");
    expect(settings.worker.args).toEqual([]);

    // The registry validates every flow a plugin declares as it loads them.
    const registry = new PluginRegistry([createDevPlugin()], {
      home: REPOSITORY,
      cwd: REPOSITORY,
      onLog: () => undefined,
    });
    expect(registry.flow("dev")?.flow.name).toBe("dev");
  });
});
