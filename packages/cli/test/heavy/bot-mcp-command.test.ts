/**
 * A home that enables the bot plugin loads: `operad bot mcp` reaches the bot
 * plugin's command even though the kernel owns the verb `mcp`, and an ordinary
 * kernel command still runs. The homes the earlier bot tests used declared no
 * plugin, so they loaded no bot and could not see the clash.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const FAKE_MCP = fileURLToPath(new URL("../../../bot/test/fake-mcp.ts", import.meta.url));

/** A home with the bot plugin enabled, with the module names `plugin enable bot` writes. */
async function makeHome(): Promise<{ root: string; home: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: {
        chat: { module: "@operad-io/chat", enabled: true },
        bot: { module: "@operad-io/bot", enabled: true },
      },
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      http: { enabled: false },
    }),
  );
  return { root, home };
}

async function operad(home: string, args: readonly string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: home,
    env: { ...testEnv(), OPERAD_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

describe("a home with the bot plugin", () => {
  test("the bot's mcp command runs as `operad bot mcp`, and a kernel command still runs", async () => {
    const { root, home } = await makeHome();
    const tools = join(root, "tools.json");
    writeFileSync(tools, JSON.stringify([{ name: "echo", description: "Say hello back." }]));

    const before = await operad(home, ["pending"]);
    expect(before.code).toBe(0);
    expect(before.out).toContain("nothing is waiting");
    expect(before.err).not.toContain("clashes");

    const registered = await operad(home, ["bot", "mcp", "default", "notes", process.execPath, FAKE_MCP, tools]);
    expect(registered.code).toBe(0);
    expect(registered.out).toContain('proposed MCP server "notes"');
    expect(registered.err).not.toContain("clashes");

    const after = await operad(home, ["pending", "--json"]);
    expect(after.code).toBe(0);
    expect(after.out).toContain("MCP server notes for bot default is waiting for your review");
  });
});
