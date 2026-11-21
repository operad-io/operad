import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEfforts } from "@operad-io/engine";
import { createPiHarnessPlugin, PI_BUILTIN_THINKING_LEVEL } from "../src/index.ts";
import { THINKING_LEVELS } from "../src/protocol.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempSettings(value?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "pi-efforts-"));
  roots.push(root);
  const path = join(root, "settings.json");
  if (value !== undefined) writeFileSync(path, JSON.stringify(value));
  return path;
}

function effortsOf(
  settingsPath: string,
  settings: Record<string, unknown> = {},
): HarnessEfforts {
  const plugin = createPiHarnessPlugin({ piSettingsPath: settingsPath });
  if (plugin.efforts === undefined) throw new Error("pi declares no efforts");
  return typeof plugin.efforts === "function" ? plugin.efforts(settings) : plugin.efforts;
}

describe("the efforts pi declares", () => {
  test("its thinking levels under the same setting, a default, and the thinking flag", () => {
    const efforts = effortsOf(tempSettings());
    expect(efforts.list).toEqual([...THINKING_LEVELS]);
    expect(efforts.default).toBe(PI_BUILTIN_THINKING_LEVEL);
    expect(efforts.list).toContain(PI_BUILTIN_THINKING_LEVEL);
    expect(efforts.flag).toBe("--thinking");
  });

  test("the default is pi's own defaultThinkingLevel when pi names one", () => {
    const settingsPath = tempSettings({ defaultThinkingLevel: "high" });
    expect(effortsOf(settingsPath).default).toBe("high");
  });

  test("operad's thinkingLevel setting wins over pi's own default", () => {
    const settingsPath = tempSettings({ defaultThinkingLevel: "high" });
    expect(effortsOf(settingsPath, { thinkingLevel: "low" }).default).toBe("low");
  });

  test("a level pi's settings do not know falls back to pi's built-in default", () => {
    const settingsPath = tempSettings({ defaultThinkingLevel: "sometimes" });
    expect(effortsOf(settingsPath).default).toBe(PI_BUILTIN_THINKING_LEVEL);
  });
});
