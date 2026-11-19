import { afterAll, describe, expect, test } from "bun:test";
import type { StepContext, ViewContext } from "@operad-io/engine";
import {
  allEntries,
  allMessages,
  CHAT_TYPE,
  chatRef,
  chatViews,
  commandOfFact,
  type Command,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

function latch(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Waits for the stop the rig sends, without sleeping for it. */
function stopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function send(ctx: StepContext, line: Record<string, unknown>): void {
  ctx.receiver?.(JSON.stringify(line));
}

async function command(r: Rig, chat: string, text: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", { note: text }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function transcript(r: Rig, chat: string): Promise<string> {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return (
    await chatViews.load(
      {
        plugin: "chat",
        home: "",
        cwd: "",
        store: r.store,
        settings: {},
      } as unknown as ViewContext,
      object,
      "transcript",
      {},
    )
  ).markdown;
}

function commands(r: Rig, chat: string): readonly Command[] {
  return r.store
    .facts(chatRef(chat))
    .facts.map(commandOfFact)
    .filter((item): item is Command => item !== undefined);
}

describe("chat:stop and chat:retry", () => {
  test("stop during text keeps the half-written reply, marked stopped, and says what happens to later messages", async () => {
    const entered = latch();
    let calls = 0;
    const r = await rig(async (ctx) => {
      calls += 1;
      send(ctx, { type: "text_delta", text: "Half a thought" });
      entered.open();
      await stopped(ctx.signal);
      return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
    });
    const chat = await r.chat();
    await r.say(chat, "go");

    const round = r.round(chat);
    await entered.promise;
    const stoppedReply = await command(r, chat, "/stop");
    expect(stoppedReply.value).toContain("stopped the reply");
    expect(stoppedReply.value).toContain("Messages that arrived meanwhile");
    expect(stoppedReply.value).toContain("/retry");
    expect((await round).result).toBe("interrupted");

    const entries = allEntries(r.store, chat);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-1", kind: "stopped", text: "Half a thought" });
    expect(allMessages(r.store, chat).filter((message) => message.role === "assistant")).toHaveLength(0);
    const shown = await transcript(r, chat);
    expect(shown).toContain("Half a thought");
    expect(shown).toContain("*stopped*");
    const line = commands(r, chat);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ command: "/stop", ok: true });
    expect(calls).toBe(1);
  });

  test("stop during a tool call stops the reply", async () => {
    const entered = latch();
    const r = await rig(async (ctx) => {
      send(ctx, { type: "tool_execution_start", toolCallId: "t1", toolName: "Bash", input: "make", at: 1_000 });
      entered.open();
      await stopped(ctx.signal);
      return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
    });
    const chat = await r.chat();
    await r.say(chat, "build it");

    const round = r.round(chat);
    await entered.promise;
    const stoppedReply = await command(r, chat, "/stop");
    expect(stoppedReply.value).toContain("stopped the reply");
    expect((await round).result).toBe("interrupted");
    expect(allMessages(r.store, chat).filter((message) => message.role === "assistant")).toHaveLength(0);
    // The call never finished, so it is not a finished entry, and no text was
    // written to mark stopped; the reply itself is no longer being written.
    const entries = allEntries(r.store, chat);
    expect(entries.filter((entry) => entry.kind === "tool")).toHaveLength(0);
    expect(entries.filter((entry) => entry.kind === "stopped")).toHaveLength(0);
    expect(await transcript(r, chat)).not.toContain("*stopped*");
    const status = await command(r, chat, "/status");
    expect(String(status.value)).toContain("Reply: not writing");
    expect(commands(r, chat)[0]).toMatchObject({ command: "/stop", ok: true });
  });

  test("stop with no reply running says so and changes nothing", async () => {
    const r = await rig(() => reply("an answer"));
    const fresh = await r.chat();
    const before = await command(r, fresh, "/stop");
    expect(before.value).toBe("no reply is running");
    expect(commands(r, fresh)[0]).toMatchObject({ command: "/stop", ok: true });

    const chat = await r.chat();
    await r.say(chat, "hi");
    await r.round(chat);
    const entries = allEntries(r.store, chat);
    const messages = allMessages(r.store, chat);
    const after = await command(r, chat, "/stop");
    expect(after.value).toBe("no reply is running");
    expect(allEntries(r.store, chat)).toEqual(entries);
    expect(allMessages(r.store, chat)).toEqual(messages);
    expect(r.calls).toHaveLength(1);
  });

  test("retry after a failure answers again on the same session, and keeps the failed attempt", async () => {
    let calls = 0;
    const r = await rig(async () => {
      calls += 1;
      if (calls === 1) return reply("first answer", "s-1");
      if (calls === 2) return { result: "failed", data: { reason: "model_error", message: "boom" } };
      return reply("second answer", "s-2");
    });
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await r.say(chat, "two");
    expect((await r.round(chat)).result).toBe("failed");
    expect(allEntries(r.store, chat).filter((entry) => entry.kind === "failure")).toHaveLength(1);
    const retried = await command(r, chat, "/retry");
    expect(retried.value).toBe("retrying the last message");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      source: "cli",
      type: "message",
      key: "retry:run-2",
      object: `chat:${chat}`,
    });

    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls).toHaveLength(3);
    expect(r.calls[2]?.params.prompt).toBe("two");
    expect(r.calls[2]?.params.resumeSession).toBe("s-1");
    expect(allEntries(r.store, chat).filter((entry) => entry.kind === "failure")).toHaveLength(1);
    expect(
      allMessages(r.store, chat)
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
    ).toEqual(["first answer", "second answer"]);
    expect(commands(r, chat)[0]).toMatchObject({ command: "/retry", ok: true });
  });

  test("retry after a stop answers again on the same session, keeps the stopped reply, and a rerun adds no entry", async () => {
    const entered = latch();
    let calls = 0;
    const r = await rig(async (ctx) => {
      calls += 1;
      if (calls === 1) return reply("first answer", "s-1");
      if (calls === 2) {
        send(ctx, { type: "text_delta", text: "partial words" });
        entered.open();
        await stopped(ctx.signal);
        return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
      }
      return reply("answer after the stop", "s-3");
    });
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);

    await r.say(chat, "two");
    const round = r.round(chat);
    await entered.promise;
    await command(r, chat, "/stop");

    // A retry right after the stop works before the stopped half reply has finished entering the record.
    const retried = await command(r, chat, "/retry");
    expect(retried.value).toBe("retrying the last message");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ key: "retry:run-2", object: `chat:${chat}` });
    expect((await round).result).toBe("interrupted");
    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls).toHaveLength(3);
    expect(r.calls[2]?.params.resumeSession).toBe("s-1");

    const entries = allEntries(r.store, chat);
    expect(entries.filter((entry) => entry.kind === "stopped").map((entry) => entry.text)).toEqual(["partial words"]);
    expect(
      allMessages(r.store, chat)
        .filter((message) => message.role === "assistant")
        .map((message) => message.text),
    ).toEqual(["first answer", "answer after the stop"]);

    // A rerun after the reply was recorded answers nothing and records no entry twice.
    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls).toHaveLength(3);
    expect(allEntries(r.store, chat)).toEqual(entries);
  });

  test("retry refuses after a normal reply and starts nothing", async () => {
    const r = await rig(() => reply("a good answer"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    const messages = allMessages(r.store, chat);

    const refused = await command(r, chat, "/retry");
    expect(refused.value).toContain("refused");
    expect(refused.value).toContain("finished normally");
    expect(r.events).toEqual([]);
    expect(r.calls).toHaveLength(1);
    expect(allMessages(r.store, chat)).toEqual(messages);
    expect(commands(r, chat)[0]).toMatchObject({ command: "/retry", ok: false });
  });

  test("/help lists stop, and retry once a reply failed", async () => {
    let calls = 0;
    const r = await rig(() => {
      calls += 1;
      return calls === 1
        ? { result: "failed", data: { reason: "model_error", message: "boom" } }
        : reply("x");
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    const help = await command(r, chat, "/help");
    expect(String(help.value)).toContain("`/stop`");
    expect(String(help.value)).toContain("`/retry`");
  });
});
