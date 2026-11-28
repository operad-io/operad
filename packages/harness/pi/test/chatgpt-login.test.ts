/**
 * The ChatGPT plan login is pi's own command (ADR 0023 D11): operad shows the
 * command a person can run and reads pi's auth file afterwards, with no
 * restart. The command is `pi auth login openai-codex` when `pi` is on PATH,
 * else the full command of the pi operad installed in the home.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import { createPiHarnessPlugin } from "../src/index.ts";
import { PI_PACKAGE, PI_VERSION, chatgptLoginCommand, homePiPackageDir } from "../src/pi-install.ts";

afterAll(cleanupTempRoots);

/** Installs a minimal pi package and its `.bin/pi` into the home's plugin project. */
function installHomePi(home: string): string {
  const dir = homePiPackageDir(home);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: PI_PACKAGE, version: PI_VERSION, exports: { ".": "./dist/index.js" } }),
  );
  writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
  const bin = join(home, "plugins", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
  chmodSync(join(bin, "pi"), 0o755);
  return join(bin, "pi");
}

describe("the ChatGPT login command", () => {
  test("is `pi auth login openai-codex` when pi is on PATH", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
    chmodSync(join(bin, "pi"), 0o755);
    const home = join(root, "home");
    installHomePi(home);
    expect(chatgptLoginCommand("pi", { path: bin, home })).toBe("pi auth login openai-codex");
  });

  test("is the full command of operad's own pi when pi is not on PATH", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const own = installHomePi(home);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(chatgptLoginCommand("pi", { path: empty, home })).toBe(`${own} auth login openai-codex`);
  });

  test("quotes a path a shell would split", async () => {
    const root = await tempRoot();
    const home = join(root, "my home");
    const own = installHomePi(home);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(chatgptLoginCommand("pi", { path: empty, home })).toBe(`'${own}' auth login openai-codex`);
  });

  test("names the `command` setting when it is one", async () => {
    const root = await tempRoot();
    expect(chatgptLoginCommand("/opt/pi/bin/pi", { home: root })).toBe("/opt/pi/bin/pi auth login openai-codex");
  });
});

describe("a login pi made elsewhere", () => {
  test("is seen by the next signedIn check, with no restart", async () => {
    const root = await tempRoot();
    const authPath = join(root, "auth.json");
    const plugin = createPiHarnessPlugin({ piSettingsPath: join(root, "settings.json") });
    const settings = { authPath, model: "openai-codex/gpt-5.6-terra" };
    expect(await plugin.signedIn?.(settings)).toBe(false);
    // What `pi auth login openai-codex` writes, from another process.
    writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "a-secret" } }));
    expect(await plugin.signedIn?.(settings)).toBe(true);
  });
});

test("the setup guide names no bare pi command for the ChatGPT login, which operad's own pi is not", async () => {
  const guide = await Bun.file(new URL("../skills/setup/SKILL.md", import.meta.url)).text();
  expect(guide).not.toContain("pi auth login");
  expect(guide).toContain("operad bot:login <bot>");
});
