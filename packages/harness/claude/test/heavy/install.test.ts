import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import {
  CLAUDE_FLOOR,
  ClaudeInstallError,
  ClaudeNotFoundError,
  compareVersions,
  inspectClaude,
  sdkVersion,
} from "../../src/claude-install.ts";
import { createClaudeHarnessPlugin } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../process/test/support.ts";

afterAll(cleanupTempRoots);

interface FakeClaude {
  /** What `claude --version` prints (a shell-quoted string). */
  readonly version?: string;
  /** What `claude auth status` prints. */
  readonly auth?: string;
  readonly authExit?: number;
}

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "someone@example.com",
  orgId: "org-secret-id",
  orgName: "Secret Org",
  subscriptionType: "max",
});

/** A `claude` shell script that prints fixed text. */
async function fakeClaude(fake: FakeClaude = {}): Promise<string> {
  const root = await tempRoot();
  const path = join(root, "claude");
  const version = fake.version ?? "2.1.319 (Claude Code)";
  const auth = fake.auth ?? LOGGED_IN;
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$1" in\n  --version) printf '%s\\n' '${version}';;\n  auth) printf '%s\\n' '${auth}'; exit ${fake.authExit ?? 0};;\n  *) exit 9;;\nesac\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("inspectClaude", () => {
  test("a current, logged-in claude reports its version and the login kind only", async () => {
    const path = await fakeClaude();
    const found = inspectClaude(path);
    expect(found.version).toBe("2.1.319");
    expect(found.login).toBe("claude.ai (max)");
    expect(JSON.stringify(found)).not.toContain("someone@example.com");
    expect(JSON.stringify(found)).not.toContain("Secret");
    expect(found.path.endsWith("/claude")).toBe(true);
  });

  test("a newer claude passes", async () => {
    const found = inspectClaude(await fakeClaude({ version: "2.2.0 (Claude Code)" }));
    expect(found.version).toBe("2.2.0");
  });

  test("an API-key login is reported by its kind", async () => {
    const auth = JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" });
    expect(inspectClaude(await fakeClaude({ auth })).login).toBe("api_key");
  });

  test("a provider other than the first party is part of the login kind", async () => {
    const auth = JSON.stringify({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" });
    expect(inspectClaude(await fakeClaude({ auth })).login).toBe("third_party (bedrock)");
  });

  test("a free-text login field is not printed", async () => {
    const auth = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "someone@example.com" });
    expect(inspectClaude(await fakeClaude({ auth })).login).toBe("claude.ai");
  });

  test("no claude command is refused and says how to fix it", () => {
    expect(() => inspectClaude(undefined, { path: "" })).toThrow(ClaudeNotFoundError);
    expect(() => inspectClaude("/nowhere/claude")).toThrow(/install claude/);
  });

  test("a version below the floor is refused and names both versions", async () => {
    const path = await fakeClaude({ version: "2.1.318 (Claude Code)" });
    expect(() => inspectClaude(path)).toThrow(`claude 2.1.318 at ${path} is older than the floor ${CLAUDE_FLOOR}`);
  });

  test("a version output it cannot parse is refused with what it printed", async () => {
    const path = await fakeClaude({ version: "hello there" });
    expect(() => inspectClaude(path)).toThrow(/did not print a version this check can read \(it printed "hello there"\)/);
  });

  test("not logged in is refused and says how to log in", async () => {
    const auth = JSON.stringify({ loggedIn: false });
    const path = await fakeClaude({ auth, authExit: 1 });
    expect(() => inspectClaude(path)).toThrow("claude is not logged in; run `claude auth login`");
  });

  test("loggedIn false with exit 0 is still refused; loggedIn true with a failing exit too", async () => {
    const said = await fakeClaude({ auth: JSON.stringify({ loggedIn: false }), authExit: 0 });
    expect(() => inspectClaude(said)).toThrow(/not logged in/);
    const failing = await fakeClaude({ auth: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), authExit: 1 });
    expect(() => inspectClaude(failing)).toThrow(/not logged in/);
  });

  test("auth status output it cannot parse is refused", async () => {
    const path = await fakeClaude({ auth: "Logged in as nobody" });
    expect(() => inspectClaude(path)).toThrow(ClaudeInstallError);
    expect(() => inspectClaude(path)).toThrow(/auth status/);
  });

  test("the refusal never carries the auth status output", async () => {
    const path = await fakeClaude({ auth: "secret-token-abc", authExit: 1 });
    try {
      inspectClaude(path);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret-token-abc");
    }
  });

  test("version comparison", () => {
    expect(compareVersions("2.1.319", "2.1.319")).toBe(0);
    expect(compareVersions("2.1.320", "2.1.319")).toBeGreaterThan(0);
    expect(compareVersions("2.0.999", "2.1.0")).toBeLessThan(0);
    expect(compareVersions("3.0.0", "2.9.9")).toBeGreaterThan(0);
  });

  test("the SDK version is a version and is only reported", async () => {
    expect(await sdkVersion()).toMatch(/^0\.3\.\d+$/);
  });
});

describe("claude check", () => {
  async function checks(command: string | undefined) {
    const root = await tempRoot();
    const registry = new PluginRegistry([createClaudeHarnessPlugin()], {
      home: root,
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      settings: { "claude": command === undefined ? {} : { command } },
    });
    return (await registry.checks()).find((item) => item.plugin === "claude");
  }

  test("passes and reports the Claude Code version, the SDK version and the login kind", async () => {
    const check = await checks(await fakeClaude());
    expect(check?.ok).toBe(true);
    const detail = JSON.stringify(check);
    expect(detail).toContain("claude 2.1.319");
    expect(detail).toMatch(/agent sdk 0\.3\.\d+/);
    expect(detail).toContain("login claude.ai (max)");
    expect(detail).not.toContain("someone@example.com");
  });

  test("fails when claude is below the floor", async () => {
    const check = await checks(await fakeClaude({ version: "2.0.0 (Claude Code)" }));
    expect(check?.ok).toBe(false);
    expect(JSON.stringify(check)).toContain("older than the floor");
  });

  test("fails when claude is not logged in", async () => {
    const check = await checks(await fakeClaude({ auth: JSON.stringify({ loggedIn: false }), authExit: 1 }));
    expect(check?.ok).toBe(false);
    expect(JSON.stringify(check)).toContain("not logged in");
  });

  test("fails when there is no claude", async () => {
    const check = await checks("/nowhere/claude");
    expect(check?.ok).toBe(false);
    expect(JSON.stringify(check)).toContain("install claude");
  });
});
