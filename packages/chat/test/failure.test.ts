import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewContext } from "@operad-io/engine";
import {
  allEntries,
  allMessages,
  answeredOfFact,
  CHAT_TYPE,
  chatFacts,
  chatViews,
  createChat,
  REPLY_FAILURE_MAX,
  unanswered,
  writingReply,
  type Entry,
} from "../src/index.ts";
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

/** Runs one reply step as `runId`, including a rerun of a run that already failed. */
async function roundAs(r: Rig, chat: string, runId: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runStep("chat/reply", {}, {
    runId,
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    params: null,
    signal: new AbortController().signal,
  });
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
      data: { reason: "exit", message: "the harness run ran out of quota at step 3; its fact flow stopped" },
    }));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    const text = failuresOf(r, chat)[0]?.text ?? "";
    // `harness` is operad's word; `run`, `step`, `flow` and `fact` are also
    // ordinary English and stay as the provider said them.
    expect(text).toBe("The reply failed: the agent run ran out of quota at step 3; its fact flow stopped");
    expect(text).not.toMatch(/\bharness\b/i);
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

  test("does not gain a second line when the same run runs again", async () => {
    let attempt = 0;
    const r = await rig(() => {
      attempt += 1;
      return attempt === 1
        ? modelError
        : { result: "failed" as const, data: { reason: "model_error", message: "503: the provider is overloaded" } };
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    expect((await roundAs(r, chat, "run-same")).result).toBe("failed");
    expect((await roundAs(r, chat, "run-same")).result).toBe("failed");

    expect(failuresOf(r, chat)).toHaveLength(1);
    expect(failuresOf(r, chat)[0]).toMatchObject({
      runId: "run-same",
      text: "The reply failed: 429: usage limit reached",
    });
    const markdown = await transcript(r, chat);
    expect(markdown.split("The reply failed: 429: usage limit reached")).toHaveLength(2);
  });

  test("a retried run that fails again records its own failure and is not called writing", async () => {
    let attempt = 0;
    const r = await rig(() => {
      attempt += 1;
      return attempt === 1
        ? modelError
        : { result: "failed" as const, data: { reason: "exit", message: "the harness exited 2" } };
    });
    const chat = await r.chat();
    await r.say(chat, "hello");
    expect((await r.round(chat)).result).toBe("failed");
    expect((await r.round(chat)).result).toBe("failed");

    const failures = failuresOf(r, chat);
    expect(failures.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
    expect(failures.map((entry) => entry.text)).toEqual([
      "The reply failed: 429: usage limit reached",
      "The reply failed: the agent exited 2",
    ]);
    expect(
      await writingReply(chatFacts(r.store, chat), allMessages(r.store, chat), allEntries(r.store, chat)),
    ).toBeUndefined();
    const markdown = await transcript(r, chat);
    expect(markdown).toContain("The reply failed: 429: usage limit reached");
    expect(markdown).toContain("The reply failed: the agent exited 2");
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
    expect(failuresOf(r, empty)[0]?.text).toBe(
      "The reply failed: the agent ended without answering and without calling the model",
    );

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

  test("an empty result that called no model says so, with the agent's own reason", async () => {
    const r = await rig(() => ({
      result: "done" as const,
      data: {
        finalMessage: "",
        sessionId: "s-1",
        usage: { tokens: { input: 0, output: 0, cacheread: 0, cachewrite: 0 }, costMicros: null },
        message: "the agent reported success; it ran the local command /clear",
      },
    }));
    const chat = await r.chat();
    await r.say(chat, "/clear");
    expect((await r.round(chat)).result).toBe("failed");

    const text = failuresOf(r, chat)[0]?.text ?? "";
    expect(text).toBe(
      "The reply failed: the agent ended without answering and without calling the model (the agent reported success; it ran the local command /clear)",
    );
    expect(text).not.toMatch(/\b(harness|run|step|fact)\b/);
  });

  test("two empty failures in a row stop the oldest message from being sent a third time", async () => {
    let attempt = 0;
    const r = await rig(() => {
      attempt += 1;
      return attempt <= 2 ? reply("") : reply("an answer");
    });
    const chat = await r.chat();
    const only = await r.say(chat, "/clear");

    expect((await r.round(chat)).result).toBe("failed");
    expect((await r.round(chat)).result).toBe("failed");
    expect(chatFacts(r.store, chat).flatMap(answeredOfFact)).toEqual([only]);
    expect(failuresOf(r, chat)).toHaveLength(2);

    await r.say(chat, "hi");
    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls[2]?.params.prompt).toBe("hi");
  });

  test("the C-0021 history answers a new message after two empty failures", async () => {
    let attempt = 0;
    const r = await rig(() => {
      attempt += 1;
      return attempt <= 2 ? reply("") : reply("the answer");
    });
    const chat = await r.chat();
    const clear = await r.say(chat, "/clear");
    expect((await r.round(chat)).result).toBe("failed");

    await r.say(chat, "hi");
    expect((await r.round(chat)).result).toBe("failed");
    expect(r.calls[1]?.params.prompt).toBe("/clear\n\n---\n\nhi");
    expect(chatFacts(r.store, chat).flatMap(answeredOfFact)).toEqual([clear]);

    await r.say(chat, "hello");
    const result = await r.round(chat);
    expect(result.result).toBe("done");
    expect(r.calls[2]?.params.prompt).toBe("hi\n\n---\n\nhello");
    expect(unanswered(allMessages(r.store, chat), chatFacts(r.store, chat))).toEqual([]);
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
