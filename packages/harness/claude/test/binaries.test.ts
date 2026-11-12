import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findClaude, ClaudeNotFoundError } from "../src/claude-install.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "win32-x64",
  "win32-arm64",
];

/** Directories that hold packages: the workspace link tree and bun's store. */
function packageDirs(): string[] {
  const found: string[] = [];
  const scopes = [
    join(ROOT, "node_modules", "@anthropic-ai"),
    join(ROOT, "node_modules", ".bun", "node_modules", "@anthropic-ai"),
    join(ROOT, "packages", "harness", "claude", "node_modules", "@anthropic-ai"),
  ];
  for (const scope of scopes) {
    if (existsSync(scope)) found.push(...readdirSync(scope).map((name) => join(scope, name)));
  }
  const store = join(ROOT, "node_modules", ".bun");
  if (existsSync(store)) {
    for (const name of readdirSync(store)) {
      if (name.startsWith("@anthropic-ai+claude-agent-sdk-")) found.push(join(store, name));
    }
  }
  return found;
}

function weight(path: string): number {
  const info = statSync(path);
  if (!info.isDirectory()) return info.size;
  return readdirSync(path).reduce((sum, name) => sum + weight(join(path, name)), 0);
}

describe("the Claude Code binary is the user's, not a dependency", () => {
  test("bun.lock resolves every platform package to the empty package", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    for (const platform of PLATFORMS) {
      const name = `@anthropic-ai/claude-agent-sdk-${platform}`;
      const entry = lock.split("\n").find((line) => line.trimStart().startsWith(`"${name}": [`));
      expect(entry, `${name} is in bun.lock`).toBeDefined();
      expect(entry).toContain("empty-npm-package@1.0.0");
    }
  });

  test("after an install no platform package holds more than a stub", () => {
    for (const dir of packageDirs()) {
      const name = dir.split("/").slice(-1)[0] ?? "";
      if (!/^claude-agent-sdk-/.test(name) && !/^@anthropic-ai\+claude-agent-sdk-/.test(name)) continue;
      // The empty package is a package.json and a readme: a few kilobytes at most.
      expect(weight(dir), `${dir} is not empty`).toBeLessThan(50_000);
    }
    // And no file anywhere under the scope is a Claude Code binary.
    for (const dir of packageDirs()) {
      if (dir.endsWith("claude-agent-sdk") || dir.includes("claude-agent-sdk@")) continue;
      if (!dir.includes("claude-agent-sdk-")) continue;
      expect(existsSync(join(dir, "claude"))).toBe(false);
    }
  });

  test("the root overrides name all eight platform packages", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      overrides?: Record<string, string>;
    };
    for (const platform of PLATFORMS) {
      expect(manifest.overrides?.[`@anthropic-ai/claude-agent-sdk-${platform}`]).toContain("empty-npm-package");
    }
  });

  test("the SDK is a range, not an exact version", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@anthropic-ai/claude-agent-sdk"]).toMatch(/^\^0\.3\./);
  });
});

describe("the claude command", () => {
  test("with no claude on PATH it fails with a message that says what to do", () => {
    expect(() => findClaude(undefined, "")).toThrow(ClaudeNotFoundError);
    expect(() => findClaude(undefined, "/nonexistent-dir")).toThrow(/install claude/);
  });
});
