import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentMissing } from "@operad-io/engine";
import { join } from "node:path";
import { createPiHarnessPlugin } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "agent-missing-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What the plugin answers with `path` as PATH. */
function missing(path: string, settings: Record<string, string | string[]> = {}, plugin = createPiHarnessPlugin()): string | undefined {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    const hook: AgentMissing | undefined = plugin.agentMissing;
    return hook?.(settings, { home: join(root, "home"), log: () => undefined });
  } finally {
    process.env.PATH = previous;
  }
}

describe("whether pi's agent is on this machine", () => {
  test("with no pi on PATH it says how to set it up", () => {
    expect(missing(root)).toContain("pi");
  });

  test("with pi on PATH nothing is missing", () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "pi"), 0o755);
    expect(missing(bin)).toBeUndefined();
  });

  test("a command the owner set is left to the check", () => {
    expect(missing(root, { command: "/opt/my-pi" })).toBeUndefined();
  });

  test("a replaced program needs no agent on PATH", () => {
    expect(missing(root, {}, createPiHarnessPlugin({ command: "bun" }))).toBeUndefined();
  });

  test("the pi operad installed in the home counts", () => {
    const dir = join(root, "home", "plugins", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    expect(missing(root)).toBeUndefined();
  });
});
