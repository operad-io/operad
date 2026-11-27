// Setup Dev on a home whose config.json does not name `dev` (ADR 0010 D7): the
// command line and the tools an agent calls both answer dev's guide with
// `enable` missing, and approving the proposal turns dev and what it needs on.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPTIONAL_PLUGINS_ENV, sharedOptionalPlugins } from "@operad-io/engine";
import { makeHome } from "@operad-io/engine/testing";
import { operad } from "@operad-io/test-support";
import { cleanupTempRoots } from "../../../engine/test/plugin/support.ts";
import { serverCommand } from "../../../harness/process/src/operad-tools.ts";
import { openMcpTools } from "../../../mcp/src/index.ts";
import { pluginOffer } from "../../src/defaults.ts";
import { openContext } from "../../src/main.ts";

const before = process.env[OPTIONAL_PLUGINS_ENV];
afterEach(() => {
  if (before === undefined) delete process.env[OPTIONAL_PLUGINS_ENV];
  else process.env[OPTIONAL_PLUGINS_ENV] = before;
});
afterAll(cleanupTempRoots);

/** The four plugins of the home the report came from. */
async function setup() {
  const made = await makeHome({
    plugins: {
      chat: { module: "@operad-io/chat", enabled: true },
      bot: { module: "@operad-io/bot", enabled: true },
      memory: { module: "@operad-io/memory", enabled: true },
      pi: { module: "@operad-io/harness-pi", enabled: true },
    },
    extra: { http: { enabled: false } },
  });
  const repo = join(made.root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  return { ...made, repo };
}

const SETUP = { plugin: "bot", verb: "setup", args: ["default", "dev"] };
const CALL = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "command", arguments: SETUP } };

/** Sends one request to a tools server started as a program and returns its output. */
async function ask(cmd: readonly string[], home: string): Promise<string> {
  const child = Bun.spawn({
    cmd: [...cmd],
    // As a harness that gives a server only its own variables.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OPERAD_HOME: home },
    stdin: new TextEncoder().encode(`${JSON.stringify(CALL)}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return out;
}

const MISSING_ENABLE = '- enable: the plugin \\"dev\\" is off';

describe("Setup Dev where config.json does not name dev", () => {
  test("the command line answers the guide, and a plugin nobody offers has none", async () => {
    const { home } = await setup();
    const steps = await operad(home, ["bot", "setup", "default", "dev"]);
    expect(steps.code).toBe(0);
    expect(steps.out).toContain('- enable: the plugin "dev" is off');
    expect(steps.out).toContain("Set up operad's dev for the repository");
    const none = await operad(home, ["bot", "setup", "default", "ghost"]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain('the plugin "ghost" has no setup guide');
  });

  test("the tools opened in an agent's process answer it once the home was opened", async () => {
    const { home } = await setup();
    delete process.env[OPTIONAL_PLUGINS_ENV];
    const context = await openContext(home, { write: () => undefined, error: () => undefined });
    context.views.close();
    await context.log.close();
    expect(sharedOptionalPlugins()).toEqual(pluginOffer(home).optional);
    const tools = await openMcpTools({ home, cwd: home });
    try {
      const result = await tools.call("command", SETUP);
      expect(result.content[0]?.text).toContain('- enable: the plugin "dev" is off');
    } finally {
      await tools.close();
    }
  });

  test("the tools server a harness starts answers it", async () => {
    const { home } = await setup();
    process.env[OPTIONAL_PLUGINS_ENV] = JSON.stringify(pluginOffer(home).optional);
    const server = serverCommand({ home });
    expect(await ask([server.command, ...server.args], home)).toContain(MISSING_ENABLE);
  });

  test("`operad mcp` answers it", async () => {
    const { home } = await setup();
    const answered = await operad(home, ["mcp"], {
      input: `${JSON.stringify(CALL)}\n`,
      env: { [OPTIONAL_PLUGINS_ENV]: undefined },
    });
    expect(answered.out).toContain(MISSING_ENABLE);
  });

  test("approving the proposal turns on dev, pool and shell", async () => {
    const { home, repo } = await setup();
    const proposed = await operad(home, ["bot", "setup-dev", "default", repo], { input: '{"name":"repo"}' });
    expect(proposed.code).toBe(0);
    const id = (await operad(home, ["pending"])).out.split(/\s+/)[0] ?? "";
    const approved = await operad(home, ["bot:approve", id]);
    expect(approved.code).toBe(0);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      readonly plugins: Readonly<Record<string, { readonly enabled?: boolean }>>;
    };
    for (const name of ["dev", "pool", "shell"]) expect(config.plugins[name]?.enabled).toBe(true);
  });
});
