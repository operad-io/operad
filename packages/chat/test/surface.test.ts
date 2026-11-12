import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createViews, type AskRequest, type JsonValue, type StepContext, type ViewContext } from "@operad-io/engine";
import {
  allMessages,
  chatViews,
  isWorktreeQuestion,
  READ_ONLY_REFUSAL,
  TRANSCRIPT_PAGE,
  WORKTREE_CALL_LIMIT,
  WORKTREE_CHOICES,
  WORKTREE_EVENT,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

async function send(r: Awaited<ReturnType<typeof rig>>, chat: string, via: string, note: string) {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction(
    "chat/send",
    { note },
    { object: { type: "chat", id: chat, data: object.data }, actor: { via, id: "me" } },
  );
}

describe("chat:send", () => {
  test("records the message as a fact and sends the event the rule answers", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await send(r, chat, "ios", "hello there");
    const messages = allMessages(r.store, chat);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "hello there",
      from: { via: "ios", id: "me" },
      attachments: [],
      source: { kind: "ios", ref: null },
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      source: "ios",
      type: "message",
      key: messages[0]?.id,
      object: `chat:${chat}`,
    });
  });

  test("a message from each known client is recorded and shown with that client", async () => {
    for (const via of ["ios", "tui", "cli"]) {
      const r = await rig(() => reply("x"));
      const chat = await r.chat();
      await send(r, chat, via, "hi");
      expect(allMessages(r.store, chat)[0]?.source.kind).toBe(via);
      expect(r.events[0]?.source).toBe(via);
    }
  });

  test("a client this plugin does not know is recorded as it is, never as cli, and is still answered", async () => {
    for (const via of ["http", "watch"]) {
      const r = await rig(() => reply("x"));
      const chat = await r.chat();
      await send(r, chat, via, "hi");
      expect(allMessages(r.store, chat)[0]?.source.kind).toBe(via);
      expect(r.events[0]?.source).toBe("other");
    }
  });

  test("the plugin's rules start chat:reply, automatically, for each source", async () => {
    const r = await rig(() => reply("x"));
    const rules = r.registry.triggerRules().map((entry) => entry.rule);
    expect(rules.map((rule) => rule.source).sort()).toEqual(["cli", "ios", "other", "telegram", "tui"]);
    for (const rule of rules) {
      expect(rule).toMatchObject({ type: "message", start: { flow: "chat:reply" }, mode: "auto", object: "$event.object" });
    }
  });

  test("an empty message is refused", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await expect(send(r, chat, "cli", "")).rejects.toThrow();
  });
});

function viewContext(r: Awaited<ReturnType<typeof rig>>, settings: Readonly<Record<string, JsonValue>> = {}): ViewContext {
  return {
    plugin: "chat",
    home: "",
    cwd: "",
    store: r.store,
    facts: { append: () => Promise.reject(new Error("read only")) },
    logger: { path: "", write: () => Promise.resolve("") },
    signal: new AbortController().signal,
    settings,
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      names: () => Promise.resolve([]),
    },
  };
}

/** Appends a message the model wrote, as the reply does. */
async function modelSay(r: Awaited<ReturnType<typeof rig>>, chat: string, text: string): Promise<void> {
  await r.store.append({
    type: "chat.message",
    object: { type: "chat", id: chat },
    cause: "test",
    data: {
      id: `m-${Math.random()}`,
      role: "assistant",
      from: { via: "", id: "" },
      text,
      attachments: [],
      source: { kind: "", ref: null },
    },
  });
}

describe("the chat's views", () => {
  test("a row names the title and the parent, and has no session in it", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    await r.store.put("chat", chat, { ...object.data, parent: "repo:app", session: "secret-session" }, "test");
    const stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    const row = chatViews.row(stored);
    expect(row).toEqual({ id: chat, title: "Test", state: "open", parent: "repo:app" });
    expect(JSON.stringify(row)).not.toContain("secret-session");
    expect(chatViews.sections(stored)).toEqual([{ id: "transcript", title: "Transcript", live: true }]);
  });

  test("the transcript pages over the message facts, in order", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const total = TRANSCRIPT_PAGE + 5;
    for (let index = 1; index <= total; index += 1) await r.say(chat, `message ${index}`);
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    const first = await chatViews.load(viewContext(r), object, "transcript", {});
    expect(first.markdown).toContain("message 1\n");
    expect(first.markdown).not.toContain(`message ${total}`);
    expect(first.next).toBeDefined();
    expect(first.pages?.map((page) => page.label)).toEqual(["Page 1", "Page 2"]);
    const second = await chatViews.load(viewContext(r), object, "transcript", { cursor: first.next });
    expect(second.markdown).toContain(`message ${total}`);
    expect(second.next).toBeUndefined();
  });

  test("an empty chat says so", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    expect((await chatViews.load(viewContext(r), object, "transcript", {})).markdown).toBe("No messages yet.");
  });

  test("the model's messages are labelled Operad Bot unless a speaker is set", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await modelSay(r, chat, "hello back");
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    const markdown = (await chatViews.load(viewContext(r, r.registry.settingsFor("chat")), object, "transcript", {})).markdown;
    expect(r.registry.settingsFor("chat").speaker).toBe("Operad Bot");
    expect(markdown).toContain("**Operad Bot**");
    expect(markdown).not.toContain("**assistant**");
  });

  test("the chat plugin's speaker setting labels a repo chat", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await modelSay(r, chat, "hello back");
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    const markdown = (await chatViews.load(viewContext(r, { speaker: "Ops" }), object, "transcript", {})).markdown;
    expect(markdown).toContain("**Ops**");
    expect(markdown).not.toContain("**Operad Bot**");
  });

  test("the chat plugin's speaker setting is read again at every draw", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await modelSay(r, chat, "hello back");
    const home = join(r.root, "home");
    const writeSpeaker = (speaker: string) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ plugins: { chat: { settings: { speaker } } } }),
      );
    };
    writeSpeaker("Ops");
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const first = await views.section(`chat:${chat}`, "transcript", undefined, {});
      expect(first.markdown).toContain("**Ops**");
      writeSpeaker("Ada");
      const second = await views.section(`chat:${chat}`, "transcript", undefined, {});
      expect(second.markdown).toContain("**Ada**");
    } finally {
      views.close();
    }
  });

  test("a bot's own speaker labels its chats, and a changed name shows on old messages", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const object = await r.store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    await r.store.put("chat", chat, { ...object.data, parent: "bot:default" }, "test");
    await r.store.put("bot", "default", { speaker: "Nova" }, "test");
    await modelSay(r, chat, "hello back");
    let stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    expect((await chatViews.load(viewContext(r), stored, "transcript", {})).markdown).toContain("**Nova**");

    await r.store.put("bot", "default", { speaker: "Ada" }, "test");
    stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    const markdown = (await chatViews.load(viewContext(r), stored, "transcript", {})).markdown;
    expect(markdown).toContain("**Ada**");
    expect(markdown).not.toContain("**Nova**");
  });
});

describe("a read-only chat", () => {
  const writeAsk = {
    prompt: "Let write use this path? /repo/a.ts",
    choices: ["allow_once", "reject_once"],
    resume: { session: "s-w", grant: { kind: "path", value: "/repo/a.ts", choice: "allow_once", tool: "write" } },
  } as const;

  test("a question about writing a file names the path and says it is a write", async () => {
    const asked: AskRequest[] = [];
    let seen: string | undefined;
    const r = await rig(async (ctx: StepContext) => {
      const answer = await ctx.ask(writeAsk);
      seen = answer.choice;
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "change it");
    const asker = {
      async ask(request: AskRequest) {
        asked.push(request);
        return { kind: "answered" as const, answer: { choice: "yes" } };
      },
      async useGrant() {
        return false;
      },
    };
    const result = await r.round(chat, {}, asker, () => undefined);
    expect(result.result).toBe("done");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toBe(
      "The agent wants to write `/repo/a.ts` in this read-only chat. Open a worktree for it?",
    );
    expect(asked[0]?.choices).toEqual([...WORKTREE_CHOICES]);
    // The full call stays on the ask for the history and a late answer.
    expect(asked[0]?.resume).toMatchObject({ session: "s-w", call: { kind: "path", value: "/repo/a.ts", tool: "write" } });
    // The agent's call is refused whatever the person said.
    expect(seen).toBe("reject_once");
  });

  test("a command that redirects output into a file is named in the worktree question too", async () => {
    const asked: AskRequest[] = [];
    const r = await rig(async (ctx: StepContext) => {
      const answer = await ctx.ask({
        prompt: "Run this command? echo x > src/a.ts",
        choices: ["allow_once", "reject_once"],
        resume: { session: "s", grant: { kind: "command", value: "echo x > src/a.ts", choice: "allow_once" } },
      });
      expect(answer.choice).toBe("reject_once");
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const asker = {
      async ask(request: AskRequest) {
        asked.push(request);
        return { kind: "answered" as const, answer: { choice: "no" } };
      },
      async useGrant() {
        return false;
      },
    };
    expect((await r.round(chat, {}, asker, () => undefined)).result).toBe("done");
    expect(asked[0]?.prompt).toBe(
      "The agent wants to run `echo x > src/a.ts` in this read-only chat. Open a worktree for it?",
    );
    expect(asked[0]?.resume).toMatchObject({ session: "s", call: { kind: "command", value: "echo x > src/a.ts" } });
  });

  test("a long command is cut in the question, and the ask keeps the whole call", async () => {
    const command = `echo ${"x".repeat(WORKTREE_CALL_LIMIT * 2)} > src/a.ts`;
    const asked: AskRequest[] = [];
    const r = await rig(async (ctx: StepContext) => {
      await ctx.ask({
        prompt: `Run this command? ${command}`,
        choices: ["allow_once", "reject_once"],
        resume: { session: "s", grant: { kind: "command", value: command, choice: "allow_once" } },
      });
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const asker = {
      async ask(request: AskRequest) {
        asked.push(request);
        return { kind: "timeout" as const, waitId: "w1", prompt: request.prompt, choices: request.choices ?? [] };
      },
      async useGrant() {
        return false;
      },
    };
    const result = await r.round(chat, {}, asker, () => undefined);
    expect(result.result).toBe("waiting");
    expect(asked[0]?.prompt).toContain("The agent wants to run `echo ");
    expect(asked[0]?.prompt).toContain("…`");
    expect(asked[0]?.prompt.length).toBeLessThan(command.length);
    // The question cuts the command; the ask keeps every character of it.
    expect(asked[0]?.resume).toMatchObject({ session: "s", call: { kind: "command", value: command } });
  });

  test("a call with no session to continue is named from its own words and still refuses once", async () => {
    const asked: AskRequest[] = [];
    let seen: { readonly choice: string | undefined; readonly note?: string | undefined } | undefined;
    const r = await rig(async (ctx: StepContext) => {
      seen = await ctx.ask({
        prompt: "Run this command? rm -r src",
        choices: ["allow_once", "reject_once"],
        onTimeout: "reject_once",
      });
      return reply("continued");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const asker = {
      async ask(request: AskRequest) {
        asked.push(request);
        // The grace passes with nobody answering.
        return { kind: "timeout" as const, waitId: "w1", prompt: request.prompt, choices: request.choices ?? [] };
      },
      async useGrant() {
        return false;
      },
    };
    const result = await r.round(chat, {}, asker, () => undefined);
    expect(result.result).toBe("done");
    expect(asked[0]?.prompt).toBe(
      "The agent wants to run `rm -r src` in this read-only chat. Open a worktree for it?",
    );
    // No session means no later answer: the live agent gets the refusal and goes on.
    expect(asked[0]?.onTimeout).toBe("reject_once");
    expect(asked[0]?.resume).toBeUndefined();
    expect(seen).toEqual({ choice: "reject_once", note: READ_ONLY_REFUSAL });
  });

  test("a no tells the agent why the call was refused and what it can do instead", async () => {
    let seen: { readonly choice: string | undefined; readonly note?: string | undefined } | undefined;
    const r = await rig(async (ctx: StepContext) => {
      seen = await ctx.ask(writeAsk);
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const asker = {
      async ask() {
        return { kind: "answered" as const, answer: { choice: "no" } };
      },
      async useGrant() {
        return false;
      },
    };
    expect((await r.round(chat, {}, asker, () => undefined)).result).toBe("done");
    expect(seen).toEqual({ choice: "reject_once", note: READ_ONLY_REFUSAL });
    expect(READ_ONLY_REFUSAL).toContain("this chat is read-only");
    expect(READ_ONLY_REFUSAL).toContain("Answer in the chat or use read-only commands");
  });

  test("a no answered after the wait gives the agent the same refusal", async () => {
    const r = await rig(() => reply("done"));
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const prompt = "The agent wants to run `ls` in this read-only chat. Open a worktree for it?";
    const result = await r.round(chat, { resumeSession: "s", askAnswer: { prompt, choice: "no" } });
    expect(result.result).toBe("done");
    expect(r.calls[0]?.params.askAnswer).toEqual({ prompt, choice: "no", note: READ_ONLY_REFUSAL });
  });

  test("a no sends nothing, and a question that is not about a call goes through unchanged", async () => {
    const asked: string[] = [];
    const r = await rig(async (ctx: StepContext) => {
      await ctx.ask(writeAsk);
      await ctx.ask({ prompt: "Which branch?", choices: ["a", "b"] });
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const asker = {
      async ask(request: { prompt: string }) {
        asked.push(request.prompt);
        return { kind: "answered" as const, answer: { choice: isWorktreeQuestion(request.prompt) ? "no" : "allow_once" } };
      },
      async useGrant() {
        return false;
      },
    };
    const emitted: string[] = [];
    expect((await r.round(chat, {}, asker, (event) => emitted.push(event.type))).result).toBe("done");
    expect(asked).toEqual([
      "The agent wants to write `/repo/a.ts` in this read-only chat. Open a worktree for it?",
      "Which branch?",
    ]);
    expect(emitted).toEqual([]);
  });

  test("a yes sends the worktree event, about the chat", async () => {
    const emitted: string[] = [];
    const r = await rig(async (ctx: StepContext) => {
      await ctx.ask(writeAsk);
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "change");
    const asker = {
      async ask() {
        return { kind: "answered" as const, answer: { choice: "yes" } };
      },
      async useGrant() {
        return false;
      },
    };
    await r.round(chat, {}, asker, (event) => emitted.push(`${event.type} ${event.object}`));
    expect(emitted).toEqual([`${WORKTREE_EVENT} chat:${chat}`]);
  });
});
