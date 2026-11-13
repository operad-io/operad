import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, allMessages } from "@operad-io/chat";
import {
  ViewError,
  type ClientApi,
  type PendingItem,
  type SourceContext,
  type ViewAction,
  type ViewEvent,
} from "@operad-io/engine";
import { PendingSender, TelegramSource, readPending } from "../src/index.ts";
import { FakeApi, createTelegramWorld, replyUpdate, tap, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ACT_REJECT = { plugin: "dev", action: "reject" };
const ACT_MERGE = { plugin: "dev", action: "merge" };

function actionInfo(plugin: string, action: string, noteRequired: boolean): ViewAction {
  return { plugin, action, on: "task", name: `${plugin}:${action}`, noteRequired, confirm: false };
}

/** A client the test drives: the items waiting, what was answered, and a way to wake the watcher. */
class StubClient {
  items: PendingItem[] = [];
  readonly acts: { name: string; id: string | undefined; note?: string | undefined; actor: unknown }[] = [];
  readonly answers: { runId: string; waitId: string; choice: string; actor: unknown }[] = [];
  /** Refuse every act and answer, as the client does for an item already answered. */
  refuse = false;
  /** What the history section of a chat reads. */
  history = "";
  private wake: ((result: IteratorResult<ViewEvent>) => void) | undefined;
  private readonly woken: ViewEvent[] = [];

  announce(): void {
    const event = { id: "x" };
    if (this.wake !== undefined) this.wake({ done: false, value: event });
    else this.woken.push(event);
  }

  asClient(w: TelegramWorld): ClientApi {
    return {
      list: (type, options) => w.views.list(type, options),
      get: async (id) => {
        return {
          id,
          type: id.split(":")[0] ?? "",
          link: "",
          row: { id, title: id, state: "open", waiting: false, running: false },
          sections: [],
          actions: [actionInfo("dev", "merge", false), actionInfo("dev", "reject", true)],
        };
      },
      section: async (id, sectionId, cursor, options) =>
        sectionId === "history" ? { markdown: this.history } : w.views.section(id, sectionId, cursor, options),
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<ViewEvent>>((resolve) => {
              const queued = this.woken.shift();
              if (queued !== undefined) resolve({ done: false, value: queued });
              else this.wake = resolve;
            }),
          return: async () => {
            // Ending the watch releases a wait that is still open.
            this.wake?.({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        }),
      }),
      pending: async () => this.items,
      act: async (name, id, options) => {
        // What the source does for a chat is the real client's work.
        if (name.startsWith("chat:") || name.startsWith("bot:")) return w.views.act(name, id, options);
        if (this.refuse) throw new ViewError("not-available", "already answered");
        this.acts.push({ name, id, note: options.note, actor: options.actor });
        this.items = this.items.filter((item) => item.object !== id);
        return { plugin: "dev", action: name, name, value: null };
      },
      answer: async (options) => {
        if (this.refuse) throw new ViewError("not-available", "already answered");
        this.answers.push({ runId: options.runId, waitId: options.waitId, choice: options.choice, actor: options.actor });
        this.items = this.items.filter((item) => item.waitId !== options.waitId);
      },
    };
  }
}

function item(fields: Partial<PendingItem> & { runId: string }): PendingItem {
  return { flow: "dev", step: null, prompt: "Merge?", choices: [], actions: [], ...fields };
}

async function setup(options: { pending?: readonly string[]; bind?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "telegram-pending-"));
  roots.push(root);
  const w = await createTelegramWorld({ root, users: [42], ...(options.pending === undefined ? {} : { pending: options.pending }) });
  const api = new FakeApi();
  let chat: string | undefined;
  if (options.bind !== false) {
    api.updates = [update(100, 42, 555, "hello")];
    await new TelegramSource(w.ctx, { api }).poll();
    chat = (await w.store.list(CHAT_TYPE)).objects[0]?.id;
    api.updates = [];
    api.sent.length = 0;
  }
  const client = new StubClient();
  const ctx: SourceContext = { ...w.ctx, client: client.asClient(w) };
  const sender = new PendingSender(ctx, { api });
  const source = new TelegramSource(ctx, { api, pending: sender });
  return { w, api, chat, client, ctx, sender, source };
}

describe("pending items go to Telegram", () => {
  test("an item of a bound chat goes to that chat, one button per choice; nothing else goes", async () => {
    const { w, api, chat, client, sender } = await setup();
    client.items = [
      item({ runId: "r1", waitId: "w1", flow: "chat", prompt: "Run rm?", choices: ["allow", "deny"], object: `chat:${chat}` }),
      item({ runId: "r2", waitId: "w2", prompt: "Other plugin's question", choices: ["ok"], object: "task:t1", actions: [ACT_MERGE] }),
    ];
    await sender.sync();
    expect(api.sent).toHaveLength(1);
    const sent = api.sent[0];
    expect(sent?.chatId).toBe(555);
    expect(sent?.text).toContain("Run rm?");
    expect(sent?.keyboard?.map((row) => row.map((button) => button.text))).toEqual([["allow"], ["deny"]]);
    // A second pass sends nothing again.
    await sender.sync();
    expect(api.sent).toHaveLength(1);
    await w.close();
  });

  test("an item of a listed plugin goes to every listed user", async () => {
    const { w, api, client, sender } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE], flow: "dev" })];
    await sender.sync();
    expect(api.sent.map((request) => request.chatId)).toEqual([42]);
    expect(api.sent[0]?.keyboard?.[0]?.[0]?.text).toBe("merge");
    await w.close();
  });

  test("dev's items are not sent by default", async () => {
    const { w, api, client, sender } = await setup({ bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    await sender.sync();
    expect(api.sent).toHaveLength(0);
    await w.close();
  });

  test("a tap acts as the telegram user, then the buttons go and the message reads answered: X", async () => {
    const { w, api, client, sender, source } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    await sender.sync();
    const messageId = 9_001;
    api.updates = [tap(200, 42, 42, messageId, "o:0")];
    await source.poll();
    expect(client.acts).toEqual([{ name: "dev:merge", id: "task:t1", note: undefined, actor: { via: "telegram", id: "42" } }]);
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.text).toEndWith("answered: merge");
    expect(api.callbacks.map((callback) => callback.callbackId)).toEqual(["cb-200"]);

    // A second tap on the same button says so and changes nothing.
    api.updates = [tap(201, 42, 42, messageId, "o:0")];
    await source.poll();
    expect(client.acts).toHaveLength(1);
    expect(api.edits).toHaveLength(1);
    expect(api.callbacks.at(-1)?.text).toBe("already answered: merge");
    await w.close();
  });

  test("a tap from an unlisted user counts for nothing", async () => {
    const { w, api, client, sender, source } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    await sender.sync();
    api.updates = [tap(200, 77, 42, 9_001, "o:0")];
    await source.poll();
    expect(client.acts).toHaveLength(0);
    expect(api.edits).toHaveLength(0);
    expect(api.callbacks.at(-1)?.text).toBeUndefined();
    await w.close();
  });

  test("a tap the client refuses reports it and does not claim an answer", async () => {
    const { w, api, client, sender, source } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    await sender.sync();
    client.refuse = true;
    api.updates = [tap(200, 42, 42, 9_001, "o:0")];
    await source.poll();
    expect(api.callbacks.at(-1)?.text).toContain("already answered");
    expect(api.edits.some((edit) => edit.text.includes("answered: merge"))).toBe(false);
    await w.close();
  });

  test("an action that needs a note has no button; replying to the message gives the note", async () => {
    const { w, api, client, sender, source } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE, ACT_REJECT] })];
    await sender.sync();
    const sent = api.sent[0];
    expect(sent?.keyboard?.map((row) => row.map((button) => button.text))).toEqual([["merge"]]);
    expect(sent?.text).toContain("Reply to this message to reject");

    // A tap carrying the note action's position is not an answer: it has no note.
    api.updates = [tap(299, 42, 42, 9_001, "o:1")];
    await source.poll();
    expect(client.acts).toHaveLength(0);

    api.updates = [replyUpdate(300, 42, 42, "not ready: tests fail", 9_001)];
    await source.poll();
    expect(client.acts).toEqual([
      { name: "dev:reject", id: "task:t1", note: "not ready: tests fail", actor: { via: "telegram", id: "42" } },
    ]);
    expect(api.edits[0]?.text).toEndWith("answered: reject");
    await w.close();
  });

  test("a reply to a button-only item is an ordinary chat message, not an answer", async () => {
    const { w, api, chat, client, sender, source } = await setup();
    client.items = [item({ runId: "r1", waitId: "w1", flow: "chat", prompt: "Run?", choices: ["allow", "deny"], object: `chat:${chat}` })];
    await sender.sync();
    api.updates = [replyUpdate(300, 42, 555, "what does it do?", 9_001)];
    await source.poll();
    expect(client.answers).toHaveLength(0);
    expect(api.edits).toHaveLength(0);
    expect(allMessages(w.ctx.store, chat ?? "").map((message) => message.text)).toEqual(["hello", "what does it do?"]);
    await w.close();
  });

  test("a question with no action and no choices is answered by a reply, through answer", async () => {
    const { w, api, chat, client, sender, source } = await setup();
    client.items = [item({ runId: "r1", waitId: "w1", flow: "chat", prompt: "Which branch?", object: `chat:${chat}` })];
    await sender.sync();
    expect(api.sent[0]?.keyboard).toBeUndefined();
    api.updates = [replyUpdate(300, 42, 555, "main", 9_001)];
    await source.poll();
    expect(client.answers).toEqual([{ runId: "r1", waitId: "w1", choice: "main", actor: { via: "telegram", id: "42" } }]);
    expect(api.edits[0]?.text).toEndWith("answered: main");
    await w.close();
  });

  test("an item answered elsewhere loses its buttons and says which action answered it", async () => {
    const { w, api, client, sender, ctx } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    await sender.sync();
    await ctx.facts.append({
      type: "action_invoked",
      object: { type: "task", id: "t1" },
      data: { action: "dev/merge", actor: { via: "cli", id: "me" } },
    });
    client.items = [];
    await sender.sync();
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.text).toEndWith("answered: merge");
    // Settled once: another pass changes nothing.
    await sender.sync();
    expect(api.edits).toHaveLength(1);
    await w.close();
  });

  test("a restart sends no item again", async () => {
    const { w, api, client, sender, ctx } = await setup({ pending: ["dev"], bind: false });
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    await sender.sync();
    expect(Object.keys(readPending(w.home))).toHaveLength(1);
    await new PendingSender(ctx, { api }).sync();
    expect(api.sent).toHaveLength(1);
    await w.close();
  });

  test("an item that wakes the watcher through events is sent", async () => {
    const { w, api, client, ctx } = await setup({ pending: ["dev"], bind: false });
    const running = new PendingSender(ctx, { api }).start();
    await running.ready;
    expect(api.sent).toHaveLength(0);
    client.items = [item({ runId: "d1", object: "task:t1", actions: [ACT_MERGE] })];
    client.announce();
    await api.nextSend();
    expect(api.sent).toHaveLength(1);
    await running.stop();
    await w.close();
  });

  test("a tap on a choice answers the question as the telegram user, and every copy of the item reads answered: X", async () => {
    const { w, api, chat, client, sender, source } = await setup({ pending: ["dev"] });
    client.items = [
      item({
        runId: "r1",
        waitId: "w1",
        flow: "chat",
        prompt: "Run rm?",
        choices: ["allow", "deny"],
        object: `chat:${chat}`,
        actions: [{ plugin: "dev", action: "noop" }],
      }),
    ];
    await sender.sync();
    expect(api.sent.map((request) => request.chatId)).toEqual([555, 42]);
    api.updates = [tap(400, 42, 555, 9_001, "o:0")];
    await source.poll();
    expect(client.answers).toEqual([{ runId: "r1", waitId: "w1", choice: "allow", actor: { via: "telegram", id: "42" } }]);
    expect(client.acts.filter((entry) => !entry.name.startsWith("chat:"))).toHaveLength(0);
    expect(api.edits.map((edit) => [edit.chatId, edit.text.split("\n\n").at(-1)])).toEqual([
      [555, "answered: allow"],
      [42, "answered: allow"],
    ]);
    await w.close();
  });

  test("a question answered somewhere else reads answered: X with the choice the history shows", async () => {
    const { w, api, chat, client, sender } = await setup();
    client.items = [item({ runId: "r1", waitId: "w1", flow: "chat", prompt: "Run rm?", choices: ["allow", "deny"], object: `chat:${chat}` })];
    await sender.sync();
    client.history = "## chat run\n- 10:00 asked you\n- 10:01 you chose allow (via cli, as me)\n";
    client.items = [];
    await sender.sync();
    expect(api.edits).toHaveLength(1);
    expect(api.edits[0]?.text).toEndWith("answered: allow");
    await w.close();
  });
});
