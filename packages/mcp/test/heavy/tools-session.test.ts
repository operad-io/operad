import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMcpTools, TOOLS } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const STDIO = fileURLToPath(new URL("../../src/stdio.ts", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

async function makeHome(): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ plugins: [pluginPath], store: { backend: "sqlite", path: join(root, "store", "log.sqlite") } }),
  );
  return home;
}

describe("the tools opened in a harness's own process", () => {
  test("offer the server's tools and run them against the home", async () => {
    const home = await makeHome();
    const tools = await openMcpTools({ home, cwd: home });
    try {
      expect(tools.tools).toBe(TOOLS);
      const listed = await tools.call("list", { type: "item" });
      expect(listed.isError).toBeUndefined();
      expect(listed.content[0]?.type).toBe("text");
    } finally {
      await tools.close();
    }
  });

  test("an unknown tool and a bad argument are error results, not throws", async () => {
    const home = await makeHome();
    const tools = await openMcpTools({ home, cwd: home });
    try {
      expect(await tools.call("nothing", {})).toMatchObject({ isError: true });
      expect(await tools.call("list", { type: 5 })).toMatchObject({ isError: true });
      expect(await tools.call("list", { type: "nosuchtype" })).toMatchObject({ isError: true });
    } finally {
      await tools.close();
    }
  });
});

describe("the stdio program", () => {
  test("answers tools/list for the home it is given and exits when its input ends", async () => {
    const home = await makeHome();
    const child = Bun.spawn({
      cmd: [process.execPath, STDIO, "--home", home],
      cwd: home,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.end();
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    const reply = JSON.parse(out.trim().split("\n")[0] ?? "{}") as { result?: { tools?: { name: string }[] } };
    expect(reply.result?.tools?.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
  });
});
