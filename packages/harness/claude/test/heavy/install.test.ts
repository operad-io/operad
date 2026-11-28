import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import {
  CLAUDE_FLOOR,
  ClaudeInstallError,
  ClaudeNotFoundError,
  PROBE_EMPTY_ATTEMPTS,
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

/**
 * A `claude` whose probes exit 0 with no output for their first `version` and
 * `auth` calls, as a spawned command may under load, and then answer.
 */
async function slowClaude(empty: { readonly version?: number; readonly auth?: number } = {}): Promise<{
  readonly path: string;
  readonly calls: () => number;
}> {
  const root = await tempRoot();
  const path = join(root, "claude");
  const calls = join(root, "calls");
  const version = empty.version ?? 0;
  const auth = empty.auth ?? 0;
  writeFileSync(
    path,
    `#!/bin/sh
total=$(cat '${calls}' 2>/dev/null || echo 0)
total=$((total + 1))
printf '%s' "$total" > '${calls}'
case "$1" in
  --version)
    probe=$(cat '${calls}.version' 2>/dev/null || echo 0)
    probe=$((probe + 1))
    printf '%s' "$probe" > '${calls}.version'
    if [ "$probe" -le ${version} ]; then exit 0; fi
    printf '%s\\n' '2.1.319 (Claude Code)';;
  auth)
    probe=$(cat '${calls}.auth' 2>/dev/null || echo 0)
    probe=$((probe + 1))
    printf '%s' "$probe" > '${calls}.auth'
    if [ "$probe" -le ${auth} ]; then exit 0; fi
    printf '%s\\n' '${LOGGED_IN}';;
  *) exit 9;;
esac
`,
  );
  chmodSync(path, 0o755);
  return { path, calls: () => Number(readFileSync(calls, "utf8")) };
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

  test("an empty success from either probe is asked again", async () => {
    const fake = await slowClaude({ version: 1, auth: 1 });
    const found = inspectClaude(fake.path);
    expect(found.version).toBe("2.1.319");
    expect(found.login).toBe("claude.ai (max)");
    // One empty answer and one real answer for each probe.
    expect(fake.calls()).toBe(4);
  });

  test("a probe that never answers is refused after a bounded number of asks", async () => {
    const fake = await slowClaude({ version: PROBE_EMPTY_ATTEMPTS });
    expect(() => inspectClaude(fake.path)).toThrow(/did not print a version/);
    // One answer and one more ask: a real empty answer is reported at once.
    expect(fake.calls()).toBeLessThanOrEqual(2);
    expect(fake.calls()).toBe(PROBE_EMPTY_ATTEMPTS);
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
    expect(() => inspectClaude(failing)).toThrow(/no login answer/);
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
  async function checks(command: string | undefined, options: { readonly workerPath?: string } = {}) {
    const root = await tempRoot();
    const registry = new PluginRegistry([createClaudeHarnessPlugin(options)], {
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

  test("is not set up, and no failure, when claude is below the floor", async () => {
    const check = await checks(await fakeClaude({ version: "2.0.0 (Claude Code)" }));
    expect(check?.ok).toBe(true);
    expect(check?.message).toStartWith("not set up: claude 2.0.0 at ");
    expect(check?.message).toContain("older than the floor");
    expect(check?.missing?.map((item) => item.name)).toEqual(["check"]);
  });

  test("is not set up, and no failure, when claude is not logged in", async () => {
    const check = await checks(await fakeClaude({ auth: JSON.stringify({ loggedIn: false }), authExit: 1 }));
    const reason = "claude is not logged in; run `claude auth login`, then check again";
    expect(check).toEqual({
      plugin: "claude",
      ok: true,
      message: `not set up: ${reason}`,
      missing: [{ name: "check", description: reason }],
    });
  });

  test("fails when claude's login answer cannot be read", async () => {
    const check = await checks(await fakeClaude({ auth: "Logged in as nobody" }));
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("auth status");
  });

  for (const [title, fake] of [
    ["has no loggedIn", { auth: JSON.stringify({ authMethod: "claude.ai" }) }],
    ["has a loggedIn that is not a boolean", { auth: JSON.stringify({ loggedIn: "false" }), authExit: 1 }],
    ["says logged in with a failing exit", { auth: JSON.stringify({ loggedIn: true }), authExit: 1 }],
  ] as const) {
    test(`fails when claude's login answer ${title}`, async () => {
      const check = await checks(await fakeClaude(fake));
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain("no login answer");
    });
  }

  for (const [title, fake] of [
    ["too old", { version: "2.0.0 (Claude Code)" }],
    ["signed out", { auth: JSON.stringify({ loggedIn: false }), authExit: 1 }],
  ] as const) {
    test(`a missing worker program fails the check with a claude that is ${title}`, async () => {
      const check = await checks(await fakeClaude(fake), { workerPath: "/nowhere/worker.ts" });
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain("the worker program is missing");
    });
  }

  test("fails when there is no claude", async () => {
    const check = await checks("/nowhere/claude");
    expect(check?.ok).toBe(false);
    expect(JSON.stringify(check)).toContain("install claude");
  });
});
