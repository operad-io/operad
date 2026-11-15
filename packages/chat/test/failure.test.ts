import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewContext } from "@operad-io/engine";
import { allEntries, allMessages, chatViews, createChat, REPLY_FAILURE_MAX, type Entry } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

async function transcript(r: Rig, chat: string): Promise<string> {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  const ctx = {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    settings: {},
  } as unknown as ViewContext;
  return (await chatViews.load(ctx, object, "transcript", {})).markdown;
}

function failuresOf(r: Rig, chat: string): readonly Entry[] {
  return allEntries(r.store, chat).filter((entry) => entry.kind === "failure");
}

const modelError = { result: "failed" as const, data: { reason: "model_error", message: "429: usage limit reached" } };

describe("a failed reply", () => {
  test("leaves one line after the person's message, saying what failed and why", async () => {
    const r = await rig(() => modelError);
    const chat = await r.chat();
    await r.say(chat, "hello");
    const result = await r.round(chat);

    expect(result.result).toBe("failed");
    const failures = failuresOf(r, chat);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      runId: "run-1",
      kind: "failure",
      text: "The reply failed: 429: usage limit reached",
    });
    const markdown = await transcript(r, chat);
    expect(markdown.indexOf("The reply failed: 429: usage limit reached")).toBeGreaterThan(markdown.indexOf("hello"));
  });

  test("masks the provider's message before it enters the chat", async () => {
    const secret = "provider-secret-value";
    const r = await rig(() => ({
      result: "failed",
      data: { reason: "model_error", message: `429: quota for ${secret} is exhausted` },
    }));
    mkdirSync(join(r.root, "home", "secrets"), { recursive: true });
    writeFileSync(join(r.root, "home", "secrets", "chat.json"), JSON.stringify({ token: secret }));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    expect(failuresOf(r, chat)[0]?.text).toBe("The reply failed: 429: quota for *** is exhausted");
    expect(JSON.stringify(allEntries(r.store, chat))).not.toContain(secret);
    expect(await transcript(r, chat)).not.toContain(secret);
  });

  test("uses the person's words for the internal names a provider's message carries", async () => {
    const r = await rig(() => ({
      result: "failed",
      data: { reason: "exit", message: "the harness run was cancelled by step 3; its fact flow stopped" },
    }));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const text = failuresOf(r, chat)[0]?.text ?? "";
    expect(text).toBe("The reply failed: the agent reply was cancelled by reply 3; its record reply stopped");
    expect(text).not.toMatch(/\b(?:harness|step|run|flow|fact)\b/i);
  });

  test("cuts a long provider message to one line", async () => {
    const long = `${"x".repeat(REPLY_FAILURE_MAX + 100)}\nmore`;
    const r = await rig(() => ({ result: "failed", data: { reason: "model_error", message: long } }));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const text = failuresOf(r, chat)[0]?.text ?? "";
    expect(text).toHaveLength(REPLY_FAILURE_MAX);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("\n");
  });

  test("shows the failure line in a radian chat too", async () => {
    const r = await rig(() => modelError, undefined, "radian");
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    expect(await transcript(r, chat)).toContain("The reply failed: 429: usage limit reached");
  });

  test("does not gain a second line when the step runs again", async () => {
    const r = await rig(() => modelError);
    const chat = await r.chat();
    await r.say(chat, "hello");
    expect((await r.round(chat)).result).toBe("failed");
    expect((await r.round(chat)).result).toBe("failed");

    expect(failuresOf(r, chat)).toHaveLength(1);
    const markdown = await transcript(r, chat);
    expect(markdown.split("The reply failed: 429: usage limit reached")).toHaveLength(2);
  });

  test("covers every way the reply fails, not only a model error", async () => {
    const r = await rig((_ctx, call) => {
      if (call.params.prompt === "empty") return reply("");
      if (call.params.prompt === "exit") {
        return { result: "failed", data: { reason: "exit", message: "the agent exited 1" } };
      }
      return reply("unexpected");
    });

    const empty = await r.chat();
    await r.say(empty, "empty");
    expect((await r.round(empty)).result).toBe("failed");
    expect(failuresOf(r, empty)[0]?.text).toBe("The reply failed: the agent gave no reply");

    const exit = await r.chat();
    await r.say(exit, "exit");
    expect((await r.round(exit)).result).toBe("failed");
    expect(failuresOf(r, exit)[0]?.text).toBe("The reply failed: the agent exited 1");

    const settings = await createChat(
      r.store,
      { harness: "fake", cwd: r.root, title: "Refreshed", refresh: "nowhere/settings" },
      "test",
    );
    await r.say(settings, "settings");
    expect((await r.round(settings)).result).toBe("failed");
    expect(failuresOf(r, settings)[0]?.text).toContain("The reply failed:");
    expect(allMessages(r.store, settings).filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  test("is not recorded for a reply that is interrupted or waiting", async () => {
    let count = 0;
    const r = await rig(async (ctx) => {
      count += 1;
      if (count === 1) return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
      await ctx.ask({ prompt: "Proceed?", choices: ["yes", "no"], resume: "s-q" });
      return reply("unexpected");
    });
    const chat = await r.chat();
    await r.say(chat, "one");
    expect((await r.round(chat)).result).toBe("interrupted");
    expect(failuresOf(r, chat)).toHaveLength(0);

    await r.say(chat, "two");
    const asker = {
      async ask() {
        return { kind: "timeout" as const, waitId: "w1", prompt: "Proceed?", choices: ["yes", "no"] };
      },
      async useGrant() {
        return false;
      },
    };
    expect((await r.round(chat, {}, asker)).result).toBe("waiting");
    expect(failuresOf(r, chat)).toHaveLength(0);
  });
});
