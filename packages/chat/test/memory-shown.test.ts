import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type PluginStepResult, type SectionContent, type StepContext, type ViewContext } from "@operad-io/engine";
import { allMessages, chatViews, memoryUsedLine, memoryWroteLine, type ReplyBlock } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

const WROTE = [{ file: "memory/topics/tea.md", summary: "How the person takes tea" }];

/** A refresh step that names the index as a note and an after step that reports what it wrote. */
function memoryPlugin(cwd: () => string, wrote: () => unknown[], afterCalls: { count: number }) {
  return definePlugin({
    name: "mem",
    kind: "domain",
    version: "0.0.0",
    steps: [
      {
        name: "refresh",
        results: ["done", "failed"],
        run(): PluginStepResult {
          return {
            result: "done",
            data: {
              cwd: cwd(),
              access: {},
              skills: [],
              notes: [{ name: "memory/index.md", path: join(cwd(), "memory", "index.md") }],
              after: "mem/commit",
            },
          };
        },
      },
      {
        name: "commit",
        results: ["done", "failed"],
        run(): PluginStepResult {
          afterCalls.count += 1;
          return { result: "done", data: { wrote: wrote() } as never };
        },
      },
    ],
  });
}

async function call(ctx: StepContext, name: string, id: string, input: string, isError = false): Promise<void> {
  for (const line of [
    { type: "tool_execution_start", toolCallId: id, toolName: name, at: 1, input },
    { type: "tool_execution_end", toolCallId: id, toolName: name, isError, durationMs: 1 },
  ]) {
    const text = JSON.stringify(line);
    await ctx.logger.write(text);
    ctx.receiver?.(text);
  }
}

async function transcript(r: Rig, chat: string): Promise<SectionContent> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
    sectionCapBytes: 256 * 1024,
    secrets: { names: async () => [], get: async () => undefined, values: async () => [] },
    runTimes: async () => ({ startedAt: 1, endedAt: 2, segments: [] }),
  } as unknown as ViewContext;
  return chatViews.load(ctx, object, "transcript", {});
}

async function setup(
  script: (ctx: StepContext) => Promise<PluginStepResult> | PluginStepResult,
  wrote: () => unknown[],
  afterCalls: { count: number },
) {
  let cwd = "";
  const r = await rig(script, undefined, undefined, "fake", [memoryPlugin(() => cwd, wrote, afterCalls)]);
  cwd = r.root;
  mkdirSync(join(cwd, "memory"), { recursive: true });
  writeFileSync(join(cwd, "memory", "index.md"), "INDEX\n");
  const chat = await r.chat({ refresh: "mem/refresh" });
  return { r, chat };
}

describe("a reply shows the memory it wrote and used", () => {
  test("names the notes the run wrote, in the reply data and the markdown", async () => {
    const afterCalls = { count: 0 };
    const { r, chat } = await setup(() => reply("ok", "s-1"), () => [...WROTE], afterCalls);
    await r.say(chat, "I like tea");
    await r.round(chat);
    const [message] = allMessages(r.store, chat).filter((item) => item.role === "assistant");
    expect(message?.memory?.wrote).toEqual(WROTE);
    const content = await transcript(r, chat);
    const blocks = (content.data as unknown as { replies: readonly ReplyBlock[] }).replies;
    expect(blocks[0]?.memory?.wrote).toEqual(WROTE);
    expect(content.markdown).toContain("*Saved to memory: memory/topics/tea.md (How the person takes tea)*");
    expect(afterCalls.count).toBe(1);
  });

  test("names the notes that rode on the message and those read through the memory tools", async () => {
    const afterCalls = { count: 0 };
    const { r, chat } = await setup(
      async (ctx) => {
        await call(ctx, "mcp__operad__read", "c-1", JSON.stringify({ id: "memory:default:topics/tea.md" }));
        await call(ctx, "mcp__operad__read", "c-2", JSON.stringify({ id: "wiki:recipes/pasta.md" }));
        await call(ctx, "Read", "c-3", join(ctx.cwd, "memory", "topics", "milk.md"));
        await call(ctx, "mcp__operad__search", "c-4", JSON.stringify({ query: "tea", scope: ["memory"] }));
        await call(ctx, "Read", "c-5", "/tmp/elsewhere/notes.md");
        await call(ctx, "mcp__operad__read", "c-6", JSON.stringify({ id: "memory:default:topics/missing.md" }), true);
        return reply("ok", "s-1");
      },
      () => [],
      afterCalls,
    );
    await r.say(chat, "what tea?");
    await r.round(chat);
    const [message] = allMessages(r.store, chat).filter((item) => item.role === "assistant");
    expect(message?.memory).toEqual({
      wrote: [],
      used: ["memory/index.md", "memory/topics/tea.md", "wiki/recipes/pasta.md", "memory/topics/milk.md"],
    });
    const content = await transcript(r, chat);
    expect(content.markdown).toContain(
      "*Used memory: memory/index.md, memory/topics/tea.md, wiki/recipes/pasta.md, memory/topics/milk.md*",
    );
    expect(content.markdown).not.toContain("Saved to memory");
  });

  test("a reply that wrote and used nothing carries no memory and no line", async () => {
    const afterCalls = { count: 0 };
    const { r, chat } = await setup(() => reply("ok", "s-1"), () => [], afterCalls);
    await r.say(chat, "first");
    await r.round(chat);
    await r.say(chat, "second");
    await r.round(chat);
    const replies = allMessages(r.store, chat).filter((item) => item.role === "assistant");
    // The second message carries no note again, so it used none.
    expect(replies[1]?.memory).toBeUndefined();
    const content = await transcript(r, chat);
    expect(content.markdown.split("Used memory").length - 1).toBe(1);
    expect(content.markdown).not.toContain("Saved to memory");
  });

  test("the lines carry the approved wording", () => {
    const memory = { wrote: WROTE, used: ["memory/index.md"] };
    expect(memoryWroteLine(memory)).toStartWith("Saved to memory: ");
    expect(memoryUsedLine(memory)).toStartWith("Used memory: ");
    expect(memoryWroteLine({ wrote: [], used: [] })).toBeUndefined();
  });
});
