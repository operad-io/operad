import { afterAll, describe, expect, test } from "bun:test";
import { definePlugin, type ActionArgsSchema } from "@operad-io/engine";
import {
  allMessages,
  CHAT_TYPE,
  chatData,
  chatRef,
  chatViews,
  COMMAND_FACT,
  commandOfFact,
  MODEL_FACT,
  promptFor,
  unanswered,
  type Command,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

const MODELS = { list: ["small", "large"], default: "small" } as const;
const EFFORTS = { list: ["low", "high"], default: "low" } as const;

type Rig = Awaited<ReturnType<typeof rig>>;

async function send(r: Rig, chat: string, note: string, via = "cli") {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", { note }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via, id: "me" },
  });
}

async function model(r: Rig, chat: string): Promise<string | undefined> {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return chatData(object.data).model;
}

function commandFacts(r: Rig, chat: string): readonly Command[] {
  return r.store
    .facts(chatRef(chat))
    .facts.map(commandOfFact)
    .filter((command): command is Command => command !== undefined);
}

function extraPlugin(
  plugin: string,
  action: string,
  command: string | undefined,
  input?: ActionArgsSchema,
) {
  return definePlugin({
    name: plugin,
    kind: "domain",
    version: "0.0.0",
    actions: [
      {
        name: action,
        on: CHAT_TYPE,
        ...(command === undefined ? {} : { command }),
        ...(input === undefined ? {} : { args: input }),
        when: () => true,
        run: (_ctx, args) => {
          const value = (args as { readonly value?: string }).value;
          return `${plugin} ran ${action}${value === undefined ? "" : ` with ${value}`}`;
        },
      },
    ],
  });
}

describe("commands in chat:send", () => {
  test("a known command runs its action, records no model message, and leaves one line", async () => {
    const r = await rig(() => reply("x"), MODELS, EFFORTS);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });

    const sent = await send(r, chat, "/model large");
    expect(sent.value).toContain("large");
    expect(await model(r, chat)).toBe("large");
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(r.events).toEqual([]);

    const lines = commandFacts(r, chat);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      from: { via: "cli", id: "me" },
      command: "/model large",
      ok: true,
    });
    expect(lines[0]?.outcome).toContain("large");
    expect(r.store.facts(chatRef(chat)).facts.filter((fact) => fact.type === MODEL_FACT)).toHaveLength(1);

    // The line is not a message, so the agent is never given it.
    await send(r, chat, "hello");
    expect(promptFor(unanswered(allMessages(r.store, chat)))).toBe("hello");
  });


  test("more than one argument is positional and the last takes the rest of the line", async () => {
    const pair = definePlugin({
      name: "pair",
      kind: "domain",
      version: "0.0.0",
      actions: [
        {
          name: "pair",
          on: CHAT_TYPE,
          command: "Pair two values.",
          args: {
            type: "object",
            properties: { first: { type: "string" }, second: { type: "string" } },
            required: ["first", "second"],
            additionalProperties: false,
          },
          when: () => true,
          run: (_ctx, args) => {
            const input = args as { readonly first: string; readonly second: string };
            return `${input.first}|${input.second}`;
          },
        },
      ],
    });
    const r = await rig(() => reply("x"), MODELS, EFFORTS, "fake", [pair]);
    const chat = await r.chat();

    const sent = await send(r, chat, "/pair a b c");
    expect(sent.value).toBe("a|b c");
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("number, integer and boolean arguments are positional and coerced", async () => {
    const typed = definePlugin({
      name: "typed",
      kind: "domain",
      version: "0.0.0",
      actions: [
        {
          name: "typed",
          on: CHAT_TYPE,
          command: "Take typed values.",
          args: {
            type: "object",
            properties: {
              count: { type: "integer" },
              ratio: { type: "number" },
              flag: { type: "boolean" },
              words: { type: "string" },
            },
            required: ["count", "ratio", "flag", "words"],
            additionalProperties: false,
          },
          when: () => true,
          run: (_ctx, args) => {
            const input = args as {
              readonly count: number;
              readonly ratio: number;
              readonly flag: boolean;
              readonly words: string;
            };
            return `${typeof input.count}:${input.count}|${typeof input.ratio}:${input.ratio}|${typeof input.flag}:${input.flag}|${input.words}`;
          },
        },
      ],
    });
    const r = await rig(() => reply("x"), MODELS, EFFORTS, "fake", [typed]);
    const chat = await r.chat();

    const sent = await send(r, chat, "/typed 3 2.5 true hello world");
    expect(sent.value).toBe("number:3|number:2.5|boolean:true|hello world");
    expect(commandFacts(r, chat)[0]).toMatchObject({ command: "/typed 3 2.5 true hello world", ok: true });
  });

  test("leading whitespace before the slash still starts a command", async () => {
    const r = await rig(() => reply("x"), MODELS, EFFORTS);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });

    const sent = await send(r, chat, "  /model large");
    expect(sent.value).toContain("large");
    expect(await model(r, chat)).toBe("large");
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(commandFacts(r, chat)[0]).toMatchObject({ command: "/model large", ok: true });
  });

  test("/help leaves out a command that is unavailable now", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();

    const help = await send(r, chat, "/help");
    const listed = String(help.value)
      .split("\n")
      .map((line: string) => /^- `\/([^`]+)`/.exec(line)?.[1])
      .filter((name: string | undefined): name is string => name !== undefined)
      .sort();
    expect(listed).toEqual(["access", "close", "help", "retry", "status", "stop"]);
    expect(String(help.value)).not.toContain("`/model`");
    expect(String(help.value)).not.toContain("`/effort`");
  });

  test("a command runs at once while a reply is being written and starts no reply", async () => {
    let markStarted: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig(async () => {
      markStarted();
      await gate;
      return reply("done");
    }, MODELS, EFFORTS);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });
    await r.say(chat, "hi");

    const round = r.round(chat);
    await entered;
    const sent = await send(r, chat, "/model large");
    expect(sent.value).toContain("large");
    expect(await model(r, chat)).toBe("large");
    expect(r.events).toEqual([]);

    release();
    expect((await round).result).toBe("done");
    expect(r.calls).toHaveLength(1);
  });

  test("an unknown slash and a slash inside the text are ordinary messages", async () => {
    for (const text of ["/usr/local is what?", "what is /usr/local?", "/nope now"]) {
      const r = await rig(() => reply("x"), MODELS, EFFORTS);
      const chat = await r.chat();
      await send(r, chat, text);
      expect(allMessages(r.store, chat).map((message) => message.text)).toEqual([text]);
      expect(r.events).toHaveLength(1);
      expect(commandFacts(r, chat)).toEqual([]);
    }
  });

  test("a missing or wrong argument is refused in a line and changes nothing", async () => {
    const r = await rig(() => reply("x"), MODELS, EFFORTS);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });

    const missing = await send(r, chat, "/model");
    expect(missing.value).toContain("refused");
    const wrong = await send(r, chat, "/model huge");
    expect(wrong.value).toContain("refused");
    expect(wrong.value).toContain("huge");

    expect(await model(r, chat)).toBe("small");
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(r.events).toEqual([]);
    const lines = commandFacts(r, chat);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.ok === false)).toBe(true);
    expect(lines.every((line) => line.outcome.startsWith("refused:"))).toBe(true);
  });

  test("a command that asks to confirm runs only with yes", async () => {
    const r = await rig(() => reply("x"), MODELS, EFFORTS);
    const chat = await r.chat();

    const bare = await send(r, chat, "/close");
    expect(bare.value).toContain("/close yes");
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).closed).toBe(false);

    const yes = await send(r, chat, "/close yes");
    expect(yes.value).toBe(`closed ${chat}`);
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).closed).toBe(true);
    const lines = commandFacts(r, chat);
    expect(lines.map((line) => [line.command, line.ok])).toEqual([
      ["/close", false],
      ["/close yes", true],
    ]);
  });

  test("the chat plugin keeps a clashing short name and another plugin gets its own", async () => {
    const other = extraPlugin(
      "other",
      "model",
      "Use another model.",
      { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    );
    const r = await rig(() => reply("x"), MODELS, EFFORTS, "fake", [other]);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });

    const own = await send(r, chat, "/model large");
    expect(own.value).toContain("chat");
    expect(await model(r, chat)).toBe("large");

    const theirs = await send(r, chat, "/other_model sonnet");
    expect(theirs.value).toBe("other ran model with sonnet");
    expect(await model(r, chat)).toBe("large");
    const lines = commandFacts(r, chat);
    expect(lines.map((line) => line.command)).toEqual(["/model large", "/other_model sonnet"]);
  });

  test("/help lists exactly the commands this chat has", async () => {
    const other = extraPlugin("other", "model", "Use another model.");
    const hidden = extraPlugin("other-two", "hidden", undefined);
    const r = await rig(() => reply("x"), MODELS, EFFORTS, "fake", [other, hidden]);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });

    const help = await send(r, chat, "/help");
    const text = String(help.value);
    const listed = text
      .split("\n")
      .map((line: string) => /^- `\/([^`]+)`/.exec(line)?.[1])
      .filter((name: string | undefined): name is string => name !== undefined)
      .sort();
    expect(listed).toEqual(["access", "close", "effort", "help", "model", "other_model", "retry", "status", "stop"]);
    expect(text).not.toContain("/send");
    expect(text).not.toContain("/hidden");
    expect(commandFacts(r, chat)[0]?.outcome).toBe(text);
  });

  test("the transcript shows the command line and the outcome", async () => {
    const r = await rig(() => reply("x"), MODELS, EFFORTS);
    const chat = await r.chat({ model: "small", effort: "low", effortDefault: "low" });
    await send(r, chat, "/effort high");

    const object = await r.store.get(CHAT_TYPE, chat);
    if (object === undefined) throw new Error("no chat");
    const content = await chatViews.load(
      {
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
      },
      object,
      "transcript",
      {},
    );
    expect(content.markdown).toContain("**you** via cli");
    expect(content.markdown).toContain("`/effort high`");
    expect(content.markdown).toContain("now uses effort high");
  });
});
