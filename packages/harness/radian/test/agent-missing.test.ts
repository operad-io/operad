import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentMissing } from "@operad-io/engine";
import { join } from "node:path";
import { createRadianHarnessPlugin } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "agent-missing-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What the plugin answers with `path` as PATH. */
function missing(path: string, settings: Record<string, string | string[]> = {}, plugin = createRadianHarnessPlugin()): string | undefined {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    const hook: AgentMissing | undefined = plugin.agentMissing;
    return hook?.(settings, { home: join(root, "home"), log: () => undefined });
  } finally {
    process.env.PATH = previous;
  }
}

describe("whether radian's agent is on this machine", () => {
  test("with no radian on PATH it says how to set it up", () => {
    expect(missing(root)).toContain("radian");
  });

  test("with radian on PATH nothing is missing", () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "radian"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "radian"), 0o755);
    expect(missing(bin)).toBeUndefined();
  });

  test("a command the owner set is left to the check", () => {
    expect(missing(root, { command: "/opt/my-radian" })).toBeUndefined();
  });
});
