import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  createViews,
  openLog,
  readHttpToken,
  startHttpServer,
  type LogBackend,
} from "@operad-io/engine";
import {
  chatRef,
  createChat,
  createChatPlugin,
  MESSAGE_FACT,
  newMessageId,
  type ReplyBlock,
  type ReplyToolItem,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { fakeHarness, reply, type Script } from "../support.ts";

afterAll(cleanupTempRoots);

interface Rig {
  readonly chat: string;
  readonly home: string;
  readonly log: LogBackend;
  readonly base: string;
  readonly token: string;
  close(): Promise<void>;
}

/** A chat whose first reply prints a long tool output, with the server that serves it. */
async function rig(output: string): Promise<Rig> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const log = openLog({ path: join(root, "store", "log.sqlite") });
  const script: Script = async (ctx) => {
    const write = async (line: Record<string, unknown>): Promise<void> => {
      const text = JSON.stringify(line);
      await ctx.logger.write(text);
      ctx.receiver?.(text);
    };
    await write({ type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", input: "produce", at: 1 });
    await write({ type: "tool_output", toolCallId: "t1", text: output });
    await write({ type: "tool_execution_end", toolCallId: "t1", toolName: "Bash", isError: false, durationMs: 1 });
    return reply("done");
  };
  const registry = new PluginRegistry([createChatPlugin(), fakeHarness("fake", script, [])], {
    home,
    cwd: root,
    store,
    onLog: () => undefined,
  });
  const views = createViews({ registry, store, log, home, onLog: () => undefined });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  const base = server.urls[0];
  if (token === undefined || base === undefined) throw new Error("the server is not reachable");
  const chat = await createChat(store, { harness: "fake", cwd: root, title: "Chat" }, "test");
  await store.append({
    type: MESSAGE_FACT,
    object: chatRef(chat),
    cause: "test",
    data: {
      id: newMessageId(),
      role: "user",
      from: { via: "cli", id: "tester" },
      text: "run it",
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
  const info = await log.startRun("chat:reply", `chat:${chat}`);
  const found = registry.flow("chat:reply");
  if (found === undefined) throw new Error("no chat flow");
  await new Runner({
    log,
    flow: found.flow,
    runId: info.runId,
    registry,
    lockRoot: join(root, "locks"),
    object: { type: "chat", id: chat },
  }).run();
  return {
    chat,
    home,
    log,
    base,
    token: token.token,
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}

function get(r: Rig, path: string): Promise<Response> {
  return fetch(`${r.base}${path}`, {
    headers: { authorization: `Bearer ${r.token}` },
  });
}

function toolOf(block: ReplyBlock | undefined): ReplyToolItem {
  const item = block?.process
    .flatMap((group) => group.items)
    .find((entry): entry is ReplyToolItem => entry.kind === "tool");
  if (item === undefined) throw new Error("the reply has no tool call");
  return item;
}

test("a tool's whole output carries the server address that serves it, and no local path", async () => {
  const output = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`).join("\n");
  const r = await rig(output);
  try {
    const section = await get(r, `/v1/objects/chat:${r.chat}/sections/transcript`);
    expect(section.status).toBe(200);
    const body = (await section.json()) as {
      readonly data?: { readonly replies?: readonly ReplyBlock[] };
    };
    const block = body.data?.replies?.[0];
    const call = toolOf(block);
    if (block === undefined) throw new Error("the reply is not structured");
    const url = `/v1/attachments/chat/${r.chat}/tool-output/${block.runId}/t1.txt`;
    expect(call.output.url).toBe(url);
    expect(call.output).not.toHaveProperty("path");
    expect(call.output.truncated).toBe(true);

    const file = await get(r, url);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(output);
  } finally {
    await r.close();
  }
});

test("the attachment route refuses a file the chat does not name, and one outside the chat", async () => {
  const output = "x".repeat(5_000);
  const r = await rig(output);
  try {
    const section = await get(r, `/v1/objects/chat:${r.chat}/sections/transcript`);
    const body = (await section.json()) as {
      readonly data?: { readonly replies?: readonly ReplyBlock[] };
    };
    const block = body.data?.replies?.[0];
    const call = toolOf(block);
    if (block === undefined || call.output.url === undefined) throw new Error("the reply has no output address");

    // A file beside the recorded one, written by hand and named by no fact.
    const beside = join(r.home, "attachments", "chat", r.chat, "tool-output", block.runId, "hand-made.txt");
    mkdirSync(dirname(beside), { recursive: true });
    writeFileSync(beside, "not in the record");
    const unrecorded = call.output.url.replace(/t1\.txt$/, "hand-made.txt");
    expect((await get(r, unrecorded)).status).toBe(404);

    // The same file shape under another chat's directory is outside this chat.
    const other = "C-9999";
    const outside = `/v1/attachments/chat/${other}/tool-output/${block.runId}/t1.txt`;
    mkdirSync(join(r.home, "attachments", "chat", other, "tool-output", block.runId), { recursive: true });
    writeFileSync(join(r.home, "attachments", "chat", other, "tool-output", block.runId, "t1.txt"), output);
    expect((await get(r, outside)).status).toBe(404);

    // A path that leaves the chat's directory is refused too.
    const escape = `/v1/attachments/chat/${r.chat}/%2e%2e/%2e%2e/%2e%2e/secret.txt`;
    expect((await get(r, escape)).status).toBe(404);
  } finally {
    await r.close();
  }
});
