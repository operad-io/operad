import { afterAll, describe, expect, test } from "bun:test";
import type { StepContext, ViewContext } from "@operad-io/engine";
import {
  allMessages,
  chatViews,
  TRANSCRIPT_PAGE,
  WORKTREE_CHOICES,
  WORKTREE_EVENT,
  WORKTREE_QUESTION,
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

  test("a client that is not a known source counts as the command line", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await send(r, chat, "tui", "hi");
    expect(r.events[0]?.source).toBe("cli");
  });

  test("the plugin's rules start chat:reply, automatically, for each source", async () => {
    const r = await rig(() => reply("x"));
    const rules = r.registry.triggerRules().map((entry) => entry.rule);
    expect(rules.map((rule) => rule.source).sort()).toEqual(["cli", "ios", "telegram"]);
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

function viewContext(r: Awaited<ReturnType<typeof rig>>): ViewContext {
  return {
    plugin: "chat",
    home: "",
    cwd: "",
    store: r.store,
    facts: { append: () => Promise.reject(new Error("read only")) },
    logger: { path: "", write: () => Promise.resolve("") },
    signal: new AbortController().signal,
    settings: {},
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      names: () => Promise.resolve([]),
    },
  };
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
});

describe("a read-only chat", () => {
  const writeAsk = {
    prompt: "Let write use this path? /repo/a.ts",
    choices: ["allow_once", "reject_once"],
    resume: { session: "s-w", grant: { kind: "path", value: "/repo/a.ts", choice: "allow_once", tool: "write" } },
  } as const;

  test("a question about writing a file becomes the worktree question and never a one-time permission", async () => {
    const asked: { prompt: string; choices?: readonly string[] | undefined }[] = [];
    let seen: string | undefined;
    const r = await rig(async (ctx: StepContext) => {
      const answer = await ctx.ask(writeAsk);
      seen = answer.choice;
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "change it");
    const asker = {
      async ask(request: { prompt: string; choices?: readonly string[] | undefined }) {
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
    expect(asked[0]?.prompt).toBe(WORKTREE_QUESTION);
    expect(asked[0]?.choices).toEqual([...WORKTREE_CHOICES]);
    // The agent's call is refused whatever the person said.
    expect(seen).toBe("reject_once");
  });

  test("a command that redirects output into a file is the worktree question too", async () => {
    const asked: string[] = [];
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
      async ask(request: { prompt: string }) {
        asked.push(request.prompt);
        return { kind: "answered" as const, answer: { choice: "no" } };
      },
      async useGrant() {
        return false;
      },
    };
    expect((await r.round(chat, {}, asker, () => undefined)).result).toBe("done");
    expect(asked).toEqual([WORKTREE_QUESTION]);
  });

  test("a no sends nothing, and a command question goes through unchanged", async () => {
    const asked: string[] = [];
    const r = await rig(async (ctx: StepContext) => {
      await ctx.ask(writeAsk);
      await ctx.ask({
        prompt: "Run this command? git push",
        choices: ["allow_once", "reject_once"],
        resume: { session: "s", grant: { kind: "command", value: "git push", choice: "allow_once" } },
      });
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true } });
    await r.say(chat, "go");
    const asker = {
      async ask(request: { prompt: string }) {
        asked.push(request.prompt);
        return { kind: "answered" as const, answer: { choice: request.prompt === WORKTREE_QUESTION ? "no" : "allow_once" } };
      },
      async useGrant() {
        return false;
      },
    };
    const emitted: string[] = [];
    expect((await r.round(chat, {}, asker, (event) => emitted.push(event.type))).result).toBe("done");
    expect(asked).toEqual([WORKTREE_QUESTION, "Run this command? git push"]);
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
