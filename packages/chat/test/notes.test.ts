import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type PluginStepResult } from "@operad-io/engine";
import { chatData } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

function refreshStep(cwd: () => string, notes: () => readonly unknown[]) {
  return definePlugin({
    name: "settings",
    kind: "domain",
    version: "0.0.0",
    steps: [
      {
        name: "refresh",
        results: ["done", "failed"],
        run(): PluginStepResult {
          return {
            result: "done",
            data: { cwd: cwd(), access: {}, skills: [], notes: notes() },
          };
        },
      },
    ],
  });
}

function indexNote(cwd: string) {
  return { name: "memory/index.md", path: join(cwd, "memory", "index.md") };
}

function instructionsNote(cwd: string) {
  return { name: "memory/instructions.md", path: join(cwd, "memory", "instructions.md") };
}

function writeNote(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("the notes on a bot chat's message", () => {
  test("a new session's first message carries the whole index and instructions", async () => {
    let cwd = "";
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [
      refreshStep(
        () => cwd,
        () => [indexNote(cwd), instructionsNote(cwd)],
      ),
    ]);
    cwd = r.root;
    writeNote(join(cwd, "memory", "index.md"), "INDEX A\n");
    writeNote(join(cwd, "memory", "instructions.md"), "RULES A\n");
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    const first = String(r.calls[0]?.params.prompt);
    expect(first).toContain("[memory/index.md]\nINDEX A\n\n[End of memory/index.md]");
    expect(first).toContain("[memory/instructions.md]\nRULES A\n\n[End of memory/instructions.md]");
    expect(first.endsWith("\n\nfirst")).toBe(true);

    await r.say(chat, "second");
    await r.round(chat);
    expect(r.calls[1]?.params.prompt).toBe("second");
  });

  test("a file changed elsewhere is sent whole on the next message, once", async () => {
    let cwd = "";
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [
      refreshStep(
        () => cwd,
        () => [indexNote(cwd)],
      ),
    ]);
    cwd = r.root;
    writeNote(join(cwd, "memory", "index.md"), "INDEX A\n");
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).toContain("INDEX A");

    writeNote(join(cwd, "memory", "index.md"), "INDEX B\n");
    await r.say(chat, "second");
    await r.round(chat);
    const second = String(r.calls[1]?.params.prompt);
    expect(second).toContain("[memory/index.md]\nINDEX B\n\n[End of memory/index.md]");
    expect(second).not.toContain("INDEX A");

    await r.say(chat, "third");
    await r.round(chat);
    expect(r.calls[2]?.params.prompt).toBe("third");
  });

  test("a change this chat's run wrote is not sent back", async () => {
    let cwd = "";
    const path = () => join(cwd, "memory", "index.md");
    const r = await rig(
      (ctx) => {
        const file = path();
        ctx.receiver?.(
          JSON.stringify({ type: "tool_execution_start", toolCallId: "c-own", toolName: "Write", at: 1, input: file }),
        );
        writeNote(file, "WRITTEN BY THIS RUN\n");
        ctx.receiver?.(
          JSON.stringify({ type: "tool_execution_end", toolCallId: "c-own", toolName: "Write", isError: false, durationMs: 1 }),
        );
        return reply("ok", "s-1");
      },
      undefined,
      undefined,
      "fake",
      [
        refreshStep(
          () => cwd,
          () => [indexNote(cwd)],
        ),
      ],
    );
    cwd = r.root;
    writeNote(path(), "BEFORE THE RUN\n");
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).toContain("BEFORE THE RUN");
    expect(String(r.calls[0]?.params.prompt)).not.toContain("WRITTEN BY THIS RUN");

    await r.say(chat, "second");
    await r.round(chat);
    expect(r.calls[1]?.params.prompt).toBe("second");
  });

  test("a change another chat wrote during the reply is sent on the next message", async () => {
    let cwd = "";
    let runs = 0;
    const path = () => join(cwd, "memory", "index.md");
    const r = await rig(
      () => {
        runs += 1;
        if (runs === 1) writeNote(path(), "WRITTEN ELSEWHERE DURING THE RUN\n");
        return reply("ok", "s-1");
      },
      undefined,
      undefined,
      "fake",
      [
        refreshStep(
          () => cwd,
          () => [indexNote(cwd)],
        ),
      ],
    );
    cwd = r.root;
    writeNote(path(), "BEFORE THE RUN\n");
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).toContain("BEFORE THE RUN");

    await r.say(chat, "second");
    await r.round(chat);
    const second = String(r.calls[1]?.params.prompt);
    expect(second).toContain("[memory/index.md]\nWRITTEN ELSEWHERE DURING THE RUN");
    expect(second).not.toContain("BEFORE THE RUN");

    await r.say(chat, "third");
    await r.round(chat);
    expect(r.calls[2]?.params.prompt).toBe("third");
  });

  test("the first message after a compaction carries the whole notes again", async () => {
    let cwd = "";
    let count = 0;
    const used = [10_000, 1_000, 2_000];
    const r = await rig(
      () => {
        count += 1;
        return {
          result: "done",
          data: { finalMessage: "ok", sessionId: "s-1", context: { used: used[count - 1] ?? 0 } },
        };
      },
      undefined,
      undefined,
      "fake",
      [
        refreshStep(
          () => cwd,
          () => [indexNote(cwd)],
        ),
      ],
    );
    cwd = r.root;
    writeNote(join(cwd, "memory", "index.md"), "INDEX A\n");
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).toContain("INDEX A");

    await r.say(chat, "second");
    await r.round(chat);
    expect(r.calls[1]?.params.prompt).toBe("second");

    // The previous reply's context was smaller: the agent compacted its
    // session, so the next message starts with the notes again.
    await r.say(chat, "third");
    await r.round(chat);
    expect(String(r.calls[2]?.params.prompt)).toContain("[memory/index.md]\nINDEX A");
  });

  test("the index is cut at its limit with a line saying so, and a change past the cut still resends it", async () => {
    let cwd = "";
    const body = `START${"a".repeat(9000)}`;
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [
      refreshStep(
        () => cwd,
        () => [{ ...indexNote(cwd), maxChars: 8000 }],
      ),
    ]);
    cwd = r.root;
    writeNote(join(cwd, "memory", "index.md"), `${body}END ONE`);
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    const first = String(r.calls[0]?.params.prompt);
    expect(first).toContain("START");
    expect(first).toContain("[memory/index.md was cut at 8000 characters.]");
    expect(first).not.toContain("END ONE");

    // Only the part past the cut changed; the whole file's hash still differs,
    // so the note goes again and is cut the same way.
    writeNote(join(cwd, "memory", "index.md"), `${body}END TWO`);
    await r.say(chat, "second");
    await r.round(chat);
    const second = String(r.calls[1]?.params.prompt);
    expect(second).toContain("[memory/index.md]\n");
    expect(second).toContain("[memory/index.md was cut at 8000 characters.]");
    expect(second).not.toContain("END TWO");

    await r.say(chat, "third");
    await r.round(chat);
    expect(r.calls[2]?.params.prompt).toBe("third");
  });

  test("the stored hashes cover the files the refresh step names now, and no others", async () => {
    let cwd = "";
    let current: readonly unknown[] = [];
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [
      refreshStep(
        () => cwd,
        () => current,
      ),
    ]);
    cwd = r.root;
    writeNote(join(cwd, "memory", "index.md"), "INDEX\n");
    writeNote(join(cwd, "memory", "instructions.md"), "RULES\n");
    current = [indexNote(cwd), instructionsNote(cwd)];
    const chat = await r.chat({ refresh: "settings/refresh" });

    await r.say(chat, "first");
    await r.round(chat);
    const afterFirst = await r.store.get("chat", chat);
    if (afterFirst === undefined) throw new Error("no chat");
    expect(Object.keys(chatData(afterFirst.data).noteHashes?.files ?? {}).sort()).toEqual([
      "memory/index.md",
      "memory/instructions.md",
    ]);

    current = [indexNote(cwd)];
    await r.say(chat, "second");
    await r.round(chat);
    const afterSecond = await r.store.get("chat", chat);
    if (afterSecond === undefined) throw new Error("no chat");
    expect(Object.keys(chatData(afterSecond.data).noteHashes?.files ?? {})).toEqual(["memory/index.md"]);
  });

  test("a chat whose refresh step names no notes gets none", async () => {
    let cwd = "";
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [
      refreshStep(
        () => cwd,
        () => [],
      ),
    ]);
    cwd = r.root;
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "hello");
    await r.round(chat);
    expect(r.calls[0]?.params.prompt).toBe("hello");
  });
});
