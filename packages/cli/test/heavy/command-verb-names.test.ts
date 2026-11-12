/**
 * A plugin command may be named like a kernel verb or like another plugin's
 * command: it is reached as `operad <plugin> <command>`, the short form is not
 * offered, and nothing fails to start.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));

function pluginSource(name: string, verbs: readonly string[]): string {
  const commands = verbs
    .map((verb) => `{ name: ${JSON.stringify(verb)}, args: "", run: () => ${JSON.stringify(`${name} ${verb}`)} }`)
    .join(", ");
  return [
    `import { definePlugin } from ${JSON.stringify(ENGINE)};`,
    `export default definePlugin({ name: ${JSON.stringify(name)}, kind: "domain", version: "1.0.0", commands: [${commands}] });`,
    "",
  ].join("\n");
}

async function makeHome(): Promise<{ root: string; home: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const one = join(root, "one.ts");
  const two = join(root, "two.ts");
  writeFileSync(one, pluginSource("one", ["mcp", "pending", "shared"]));
  writeFileSync(two, pluginSource("two", ["shared"]));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: { one: { module: one }, two: { module: two } },
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

describe("plugin commands named like kernel verbs or each other", () => {
  test("the CLI starts, the kernel verb runs and the plugin command runs through its plugin", async () => {
    const { home } = await makeHome();

    const kernel = await operad(home, ["pending"]);
    expect(kernel.code).toBe(0);
    expect(kernel.out).not.toContain("one pending");
    // Nothing on stderr: serve's reload probe reads any load line as a problem.
    expect(kernel.err).toBe("");

    const viaPlugin = await operad(home, ["one", "pending"]);
    expect(viaPlugin.code).toBe(0);
    expect(viaPlugin.out).toContain("one pending");

    const mcp = await operad(home, ["one", "mcp"]);
    expect(mcp.code).toBe(0);
    expect(mcp.out).toContain("one mcp");

    const first = await operad(home, ["one", "shared"]);
    expect(first.out).toContain("one shared");
    const second = await operad(home, ["two", "shared"]);
    expect(second.out).toContain("two shared");
    const short = await operad(home, ["shared"]);
    expect(short.code).not.toBe(0);
  });

  test("serve loads such a plugin", async () => {
    const { home } = await makeHome();
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: { ...testEnv(), OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let seen = "";
    try {
      const reader = serve.stdout.getReader();
      const decoder = new TextDecoder();
      while (!seen.includes("serving")) {
        const read = await reader.read();
        if (read.done) {
          throw new Error(
            `serve ended before it was serving: ${seen}${await new Response(serve.stderr).text()}`,
          );
        }
        seen += decoder.decode(read.value, { stream: true });
      }
      reader.releaseLock();
      const viaPlugin = await operad(home, ["one", "mcp"]);
      expect(viaPlugin.out).toContain("one mcp");
    } finally {
      serve.kill("SIGTERM");
      await serve.exited;
    }
  });
});
