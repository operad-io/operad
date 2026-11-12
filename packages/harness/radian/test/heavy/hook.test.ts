import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import { createRadianHarnessPlugin } from "../../src/index.ts";

const HOOK = join(import.meta.dir, "..", "..", "src", "hook.ts");
const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-radian-hook-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

async function hook(profile: unknown, call: unknown): Promise<{ code: number; err: string }> {
  const file = join(temp(), "profile.json");
  writeFileSync(file, JSON.stringify(profile));
  const child = Bun.spawn([process.execPath, HOOK, file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify(call));
  child.stdin.end();
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, err };
}

const call = (tool_name: string, tool_input: unknown) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/work" });

test("the hook program denies with exit 2 and the reason for a write, a command that writes and a denied path", async () => {
  const refused = await hook({ readOnly: true }, call("write", { path: "a.ts", content: "x" }));
  expect(refused.code).toBe(2);
  expect(refused.err).toBe("write call is refused: this chat is read-only here. Do not retry it; tell the person what you want to change, and they can open a worktree for it.\n");
  expect((await hook({ readOnly: true }, call("shell", { command: "echo x &> a.ts" }))).code).toBe(2);
  expect((await hook({ readOnly: true }, call("shell", { command: "cat a | tee b" }))).code).toBe(2);
  expect((await hook({ denyPaths: ["/secrets"] }, call("read", { path: "/secrets/key" }))).code).toBe(2);
});

test("the hook program denies a patch in every form, an unknown tool and a user's MCP tool in a read-only directory", async () => {
  const readOnly = { readOnly: true };
  expect((await hook(readOnly, call("patch", { path: "a.ts", old: "a", new: "b" }))).code).toBe(2);
  expect((await hook(readOnly, call("patch", { path: "a.ts", edits: [{ old: "a", new: "b" }] }))).code).toBe(2);
  expect((await hook(readOnly, call("patch", { edits: [{ path: "src/a.ts", old: "a", new: "b" }] }))).code).toBe(2);
  const mcp = await hook(readOnly, call("notes__add", { text: "x" }));
  expect(mcp.code).toBe(2);
  expect(mcp.err).toContain("only reading tools and operad's tools run");
  expect((await hook(readOnly, call("subagent", { prompt: "edit it" }))).code).toBe(2);
  // Outside a read-only directory every path of a patch is judged, and a patch that names none is refused.
  const denied = { denyPaths: ["/secrets"] };
  expect((await hook(denied, call("patch", { edits: [{ path: "ok.ts", old: "a", new: "b" }, { path: "/secrets/k", old: "a", new: "b" }] }))).code).toBe(2);
  expect((await hook(denied, call("patch", { path: "ok.ts", edits: [{ path: "/secrets/k", old: "a", new: "b" }] }))).code).toBe(2);
  expect((await hook(denied, call("patch", { edits: [{ old: "a", new: "b" }] }))).code).toBe(2);
  expect((await hook(denied, call("patch", { path: "ok.ts", edits: [{ old: "a", new: "b" }] }))).code).toBe(0);
});

test("the hook program lets a read, a reading command and an operad tool through", async () => {
  expect((await hook({ readOnly: true }, call("read", { path: "a.ts" }))).code).toBe(0);
  expect((await hook({ readOnly: true }, call("shell", { command: "git log | head" }))).code).toBe(0);
  expect((await hook({ readOnly: true }, call("operad__act", { id: "task:1" }))).code).toBe(0);
  expect((await hook({ readOnly: true }, call("grep", { pattern: "x" }))).code).toBe(0);
});

test("a hook that cannot read its profile does not let the call through", async () => {
  expect((await hook({ readOnly: "yes" }, call("read", { path: "a.ts" }))).code).toBe(3);
});

// The real radian, with a model that is a scripted local server: the hook runs inside radian.
const radian = Bun.which("radian");

async function runReal(access: Record<string, unknown>): Promise<{ wrote: boolean; result: string; text: string }> {
  const root = temp();
  const work = join(root, "work");
  mkdirSync(work);
  const radianHome = join(root, "radian-home");
  mkdirSync(radianHome);
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      const first = calls === 1;
      const delta = first
        ? { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) } }] }
        : { content: "done" };
      const chunk = (d: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }], ...(finish === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) })}\n\n`;
      return new Response(`${chunk({ role: "assistant", ...delta }, null)}${chunk({}, first ? "tool_calls" : "stop")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const previousHome = process.env.RADIAN_HOME;
  const previousConfig = process.env.RADIAN_CONFIG;
  process.env.RADIAN_HOME = radianHome;
  delete process.env.RADIAN_CONFIG;
  try {
    const registry = new PluginRegistry([createRadianHarnessPlugin()], {
      home: join(root, "home"),
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      onLog: () => undefined,
    });
    const outcome = await registry.runStep(
      "radian/agent",
      { prompt: "write a.txt", cwd: work, args: ["--provider", "openai-compatible", "--model", "m", "--base-url", `http://127.0.0.1:${server.port}`] },
      { runId: "run-real", access: access as never },
    );
    const data = (outcome.data ?? {}) as Record<string, unknown>;
    return { wrote: existsSync(join(work, "a.txt")), result: outcome.result, text: String(data.finalMessage ?? data.message ?? "") };
  } finally {
    server.stop(true);
    if (previousHome === undefined) delete process.env.RADIAN_HOME;
    else process.env.RADIAN_HOME = previousHome;
    if (previousConfig !== undefined) process.env.RADIAN_CONFIG = previousConfig;
  }
}

test.skipIf(radian === null || process.env.PATH?.split(delimiter).length === 0)(
  "in radian itself a read-only profile stops the write tool before it runs, and without one the same call writes",
  async () => {
    const readOnly = await runReal({ readOnly: true });
    expect(readOnly.wrote).toBe(false);
    expect(readOnly.result).toBe("done");
    const free = await runReal({});
    expect(free.wrote).toBe(true);
  },
  60_000,
);
