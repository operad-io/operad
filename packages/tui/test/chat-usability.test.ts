import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ViewAction, ViewObject, ViewSectionContent } from "@operad-io/engine";
import {
  initialState,
  reduce,
  sectionTailLayout,
  type TuiState,
  type TuiStateEvent,
} from "../src/state.ts";
import { drawState, paletteFor } from "../src/view/index.ts";
import { KEY_LIST } from "../src/state.ts";
import { footerOf, treeRows } from "./support.ts";
import { chatMarkdown } from "../src/chat.ts";
import { chatMarkdownCached, chatStats } from "../src/state.ts";
import { toRgba } from "../src/theme.ts";
import { createTuiView, runTui } from "../src/index.ts";

const NOTE = { type: "string", role: "note" } as const;

function action(name: string, extra: Partial<ViewAction> = {}): ViewAction {
  const [plugin = "", short = ""] = name.split(":");
  return { plugin, action: short, on: "chat", name, noteRequired: false, confirm: false, ...extra };
}

const SEND = action("chat:send", {
  args: { type: "object", properties: { note: NOTE }, additionalProperties: false },
  note: "note",
});
const STOP = action("chat:stop");
const MODEL = action("chat:model");

const ROW = { id: "chat:one", title: "One", state: "open", waiting: false, running: false };

interface ChatOptions {
  readonly type?: string | undefined;
  readonly markdown?: string | undefined;
  readonly tail?: string | undefined;
  readonly running?: boolean | undefined;
  readonly actions?: readonly ViewAction[] | undefined;
}

function objectState(options: ChatOptions = {}): TuiState {
  const type = options.type ?? "chat";
  const row = { ...ROW, id: `${type}:one`, running: options.running === true };
  const object: ViewObject = {
    id: `${type}:one`,
    type,
    link: "x",
    row,
    sections: [{ id: "transcript", title: "Transcript", live: true }],
    actions: options.actions ?? [SEND, STOP, MODEL],
  };
  let state = initialState({ width: 120, height: 30, theme: "dark" });
  state = reduce(state, { type: "types", types: [{ type, title: type, plugin: type }] });
  state = reduce(state, treeRows(`plugin:${type}`, [row]));
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, { type: "object", object });
  const content: ViewSectionContent = {
    markdown: options.markdown ?? "",
    ...(options.tail === undefined ? {} : { tail: options.tail }),
  };
  return reduce(state, {
    type: "section",
    objectId: `${type}:one`,
    sectionId: "transcript",
    content,
  });
}

const typeText = (text: string): TuiStateEvent[] =>
  [...text].map((char) => ({ type: "key", key: char === " " ? "space" : char, text: char }));

function press(state: TuiState, ...keys: (string | TuiStateEvent)[]): TuiState {
  let next = state;
  for (const key of keys) {
    next = reduce(
      next,
      typeof key === "string" ? { type: "key", key, ...(key.length === 1 ? { text: key } : {}) } : key,
    );
  }
  return next;
}

function note(text = ""): TuiState {
  const opened = press(objectState(), "a");
  expect(opened.input?.kind).toBe("note");
  return text === "" ? opened : press(opened, ...typeText(text));
}

function noteText(state: TuiState): string | undefined {
  return state.input?.kind === "note" ? state.input.text : undefined;
}

function inputCursor(state: TuiState): number | undefined {
  return state.input?.kind === "note" ? state.input.cursor : undefined;
}

const NOW = Date.UTC(2026, 10, 15, 12, 0);
const HEADER = "**you** via tui · 2026-11-15 04:30";

function right(state: TuiState, now = NOW, timeZone = "UTC"): string {
  return drawState(state, "dark", now, timeZone).right.chunks.map((part) => part.text).join("");
}

describe("a chat send that the server has not accepted", () => {
  test("its input stays open with the text, a refusal shows there, and escape discards", () => {
    let state = press(note("hello"), "enter");
    expect(state.actionRequest).toEqual({ action: "chat:send", id: "chat:one", note: "hello" });
    expect(state.input).toMatchObject({ kind: "note", text: "hello", sending: true });

    state = reduce(state, { type: "action-launched" });
    expect(state.input).toMatchObject({ kind: "note", text: "hello", sending: true });

    state = reduce(state, { type: "action-error", status: 422, message: "422 the chat is closed" });
    expect(state.input).toMatchObject({
      kind: "note",
      text: "hello",
      sending: false,
      error: "the chat is closed",
    });
    expect(state.notice).toBeUndefined();
    const overlay = drawState(state, "dark", NOW, "UTC").overlay?.chunks.map((part) => part.text).join("") ?? "";
    expect(overlay).toContain("hello");
    expect(overlay).toContain("the chat is closed");

    expect(press(state, "escape").input).toBeUndefined();
  });

  test("a refusal leaves the message out of the transcript, and acceptance closes the input", () => {
    const prepared = objectState({ markdown: "hello" });
    let state = press(prepared, "a", ...typeText("new message"), "enter");
    expect(state.object?.sections[0]?.optimistic?.map((entry) => entry.text)).toEqual(["new message"]);
    state = reduce(state, { type: "action-error", message: "422 the chat is closed" });
    expect(state.object?.sections[0]?.optimistic).toEqual([]);

    const accepted = press(prepared, "a", ...typeText("new message"), "enter");
    const done = reduce(accepted, { type: "action-done" });
    expect(done.input).toBeUndefined();
    expect(done.object?.sections[0]?.optimistic?.map((entry) => entry.text)).toEqual(["new message"]);
  });
});

describe("the note input's cursor", () => {
  test("left and right, home and end, ctrl-a and ctrl-e, and delete edit where the cursor is", () => {
    let state = note("ac");
    state = press(state, "left", ...typeText("b"));
    expect(noteText(state)).toBe("abc");
    expect(inputCursor(state)).toBe(2);
    state = press(state, "home");
    expect(inputCursor(state)).toBe(0);
    state = press(state, "delete");
    expect(noteText(state)).toBe("bc");
    state = press(state, "end");
    expect(inputCursor(state)).toBe(2);
    state = press(state, { type: "key", key: "a", ctrl: true });
    expect(inputCursor(state)).toBe(0);
    state = press(state, { type: "key", key: "e", ctrl: true });
    expect(inputCursor(state)).toBe(2);
    state = press(state, "backspace");
    expect(noteText(state)).toBe("b");
  });

  test("alt-left and alt-right move by words, and up and down move between lines", () => {
    let state = note("one two three");
    state = press(state, { type: "key", key: "left", meta: true });
    expect(inputCursor(state)).toBe(8);
    state = press(state, ...typeText("X"));
    expect(noteText(state)).toBe("one two Xthree");
    state = press(state, { type: "key", key: "right", meta: true });
    expect(inputCursor(state)).toBe(14);

    state = note("ab");
    state = press(state, { type: "key", key: "enter", shift: true }, ...typeText("cdef"));
    state = press(state, "up");
    expect(inputCursor(state)).toBe(2);
    state = press(state, "up");
    expect(inputCursor(state)).toBe(0);
    state = press(state, "down");
    expect(inputCursor(state)).toBe(3);
    state = press(state, "down");
    expect(inputCursor(state)).toBe(7);
  });
});

describe("a paste into a chat's input", () => {
  test("line breaks are text, not a send, and other control bytes are dropped", () => {
    let state = note("start ");
    state = reduce(state, { type: "paste", text: "one\r\ntwo\tthree\u001b" });
    expect(noteText(state)).toBe("start one\ntwo    three");
    expect(inputCursor(state)).toBe("start one\ntwo    three".length);
    expect(state.actionRequest).toBeUndefined();
    state = press(state, "enter");
    expect(state.actionRequest).toEqual({
      action: "chat:send",
      id: "chat:one",
      note: "start one\ntwo    three",
    });
  });
});

describe("a chat transcript folds its thinking and tool lines", () => {
  const RUN = `${HEADER}\n\nhello\n\n> think one\n> think two\n\ntool Bash 3s \`ls\`\n\nworld`;
  const TAIL = "> still thinking\n\ntool Read 1s";

  test("a run is one line with its count and its last line, and enter opens it", () => {
    let state = objectState({ markdown: RUN });
    let drawn = right(state);
    expect(drawn).toContain("3 · tool Bash 3s ls");
    expect(drawn).not.toContain("think one");

    state = press(state, "enter");
    drawn = right(state);
    expect(drawn).toContain("think one");
    expect(drawn).toContain("think two");
    expect(drawn).toContain("tool Bash 3s ls");
    expect(drawn).not.toContain("3 · tool Bash");

    state = press(state, "enter");
    expect(right(state)).toContain("3 · tool Bash 3s ls");
  });

  test("the run at the selected line opens, not always the latest one", () => {
    const two = "> first thought\n\ntool First 1s\n\nmiddle\n\n> second thought\n\ntool Second 2s";
    let state = objectState({ markdown: two });
    state = reduce(state, {
      type: "section",
      objectId: "chat:one",
      sectionId: "transcript",
      content: { markdown: two },
    });
    const folded = right(state);
    expect(folded).toContain("2 · tool First 1s");
    expect(folded).toContain("2 · tool Second 2s");

    state = press(state, "enter");
    const opened = right(state);
    expect(opened).toContain("first thought");
    expect(opened).toContain("First 1s");
    expect(opened).not.toContain("2 · tool First 1s");
    expect(opened).toContain("2 · tool Second 2s");
  });

  test("Enter still opens the selected row when another row is selected", () => {
    let state = objectState({
      markdown: "> first thought\n\ntool First 1s\n\n> second thought\n\ntool Second 2s",
    });
    state = reduce(
      state,
      treeRows("plugin:chat", [ROW, { ...ROW, id: "chat:two", title: "Two" }]),
    );
    state = press(state, "down");
    expect(state.object?.source).toBe("chat:one");
    state = press(state, "enter");
    expect(state.objectRequest?.id).toBe("chat:two");
    expect(state.object?.sections[0]?.folds).toBeUndefined();
  });

  test("the unfinished part folds the same way, and its run opens too", () => {
    let state = objectState({ markdown: "hello", tail: TAIL });
    let drawn = right(state);
    expect(drawn).toContain("2 · tool Read 1s");
    expect(drawn).not.toContain("still thinking");
    state = press(state, "enter");
    drawn = right(state);
    expect(drawn).toContain("still thinking");
    expect(drawn).not.toContain("2 · tool Read 1s");
    expect(sectionTailLayout(state, state.object?.sections[0] as never).length).toBeGreaterThan(0);
  });
});

describe("stopping a reply", () => {
  test("the footer offers the stop key and the key runs the stop action", () => {
    const state = objectState({ running: true });
    expect(footerOf(state)).toContain("a stop");
    expect(press(state, "a").actionRequest).toEqual({ action: "chat:stop", id: "chat:one" });
    const keys = KEY_LIST.map(([key]) => key);
    expect(keys).toContain("/");
    expect(keys).toContain("a");
    expect(keys).toContain(":");
  });

  test("a bound stop key is the one the footer offers", () => {
    const state = reduce(objectState({ running: true }), {
      type: "keys",
      bindings: [{ key: "s", action: "chat:stop", source: "plugin" }],
    });
    expect(footerOf(state)).toContain("s stop");
    expect(press(state, "s").actionRequest).toEqual({ action: "chat:stop", id: "chat:one" });
    const help = drawState({ ...state, keys: true }, "dark", NOW, "UTC").overlay?.chunks.map((part) => part.text).join("") ?? "";
    expect(help).toContain("a / s");
    expect(help).toContain("stop");
  });
});

describe("a chat message header", () => {
  test("shows who and the time in the terminal's zone, without the transport or today's date", () => {
    const state = objectState({ markdown: HEADER });
    const drawn = right(state);
    expect(drawn).toContain("you · 04:30");
    expect(drawn).not.toContain("via tui");
    expect(drawn).not.toContain("2026-11-15");
  });

  test("keeps the date on another day, and leaves a non-chat section alone", () => {
    const tomorrow = Date.UTC(2026, 10, 16, 12, 0);
    expect(right(objectState({ markdown: HEADER }), tomorrow)).toContain("you · 2026-11-15 04:30");
    const other = objectState({ type: "item", markdown: HEADER });
    const drawn = right(other);
    expect(drawn).toContain("via tui");
    expect(drawn).toContain("2026-11-15 04:30");
  });
});

describe("a message drawn before the server's copy", () => {
  test("is weak at the end of the transcript until the copy replaces it, once", () => {
    let state = press(objectState({ markdown: HEADER }), "a", ...typeText("new message"), "enter");
    const weak = toRgba(paletteFor("dark", "dark").weak).toInts().join(",");
    const part = drawState(state, "dark", NOW, "UTC").right.chunks.find((chunk) => chunk.text.includes("new message"));
    expect(part?.fg?.toInts().join(",")).toBe(weak);

    state = reduce(state, { type: "action-done" });
    state = reduce(state, {
      type: "section",
      objectId: "chat:one",
      sectionId: "transcript",
      content: { markdown: `${HEADER}\n\nnew message` },
    });
    expect(state.object?.sections[0]?.optimistic).toEqual([]);
    const text = right(state);
    expect(text.split("new message")).toHaveLength(2);
  });
});

test("chatMarkdown folds a run without a header and leaves other text as it was", () => {
  expect(chatMarkdown("plain\n\n> a\n\n> b\n\ntool X\n\nplain", { now: NOW, timeZone: "UTC" })).toContain("3 · tool X");
});

test("chatMarkdown keeps its result for the same inputs, and the same local day", () => {
  const source = `${HEADER}\n\n> think one\n> think two`;
  const before = chatStats.computed;
  const first = chatMarkdownCached(source, { now: NOW, timeZone: "UTC" });
  expect(chatStats.computed).toBe(before + 1);
  expect(chatMarkdownCached(source, { now: NOW, timeZone: "UTC" })).toBe(first);
  expect(chatMarkdownCached(source, { now: NOW + 60_000, timeZone: "UTC" })).toBe(first);
  expect(chatStats.computed).toBe(before + 1);
  expect(chatMarkdownCached(source, { now: NOW + 86_400_000, timeZone: "UTC" })).not.toBe(first);
  expect(chatStats.computed).toBe(before + 2);
});


describe("the terminal's bracketed paste", () => {
  test("its bytes reach the open input, and the mode follows the input and the exit", async () => {
    const send = action("chat:send", {
      args: { type: "object", properties: { note: NOTE }, additionalProperties: false },
      note: "note",
    });
    const row = { id: "C-0001", title: "One", state: "open", waiting: false, running: false };
    const object = {
      id: "C-0001",
      type: "chat",
      link: "x",
      row,
      sections: [{ id: "transcript", title: "Transcript", live: true }],
      actions: [send, STOP],
    };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/types") {
          return Response.json({ types: [{ type: "chat", title: "Chat", plugin: "chat" }] });
        }
        if (url.pathname === "/v1/pending" || url.pathname === "/v1/running") {
          return Response.json([]);
        }
        if (url.pathname === "/v1/keys") return Response.json({ keys: [] });
        if (url.pathname === "/v1/events") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": ready\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/v1/objects") {
          const parent = url.searchParams.get("parent");
          return Response.json(parent === null ? { rows: [row] } : { rows: [] });
        }
        if (url.pathname.endsWith("/sections/transcript")) {
          return Response.json({ markdown: "" });
        }
        if (url.pathname.startsWith("/v1/objects/")) return Response.json(object);
        if (url.pathname === "/v1/act") return Response.json({ value: "sent" });
        return new Response("not found", { status: 404 });
      },
    });
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const waiters: { check: (state: TuiState) => boolean; resolve: () => void }[] = [];
    let latest: TuiState | undefined;
    const until = (check: (state: TuiState) => boolean): Promise<void> => {
      if (latest !== undefined && check(latest)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ check, resolve }));
    };
    const pasteModes: boolean[] = [];
    const controller = new AbortController();
    const running = runTui({
      url: `http://127.0.0.1:${server.port}`,
      token: "t",
      signal: controller.signal,
      hooks: {
        renderer: async () => setup.renderer,
        pasteMode: (on) => pasteModes.push(on),
        view: (ctx) => {
          const real = createTuiView(ctx);
          return {
            render(state) {
              latest = state;
              for (const waiter of waiters.splice(0)) {
                if (waiter.check(state)) waiter.resolve();
                else waiters.push(waiter);
              }
              real.render(state);
            },
            destroy: () => real.destroy(),
          };
        },
      },
    });
    try {
      await until((state) => state.tabs.find((tab) => tab.id === "plugin:chat")?.list.loaded === true);
      setup.mockInput.pressKey("3");
      await until((state) => state.active === 2);
      setup.mockInput.pressEnter();
      await until(
        (state) =>
          state.object?.type === "chat" &&
          !state.object.loading &&
          state.object.sections[0]?.loaded === true,
      );
      setup.mockInput.pressKey("a");
      await until((state) => state.input?.kind === "note");
      await setup.mockInput.pasteBracketedText("line one\nline two");
      await until(
        (state) => state.input?.kind === "note" && state.input.text === "line one\nline two",
      );
      expect(latest?.actionRequest).toBeUndefined();
      expect(pasteModes).toEqual([true]);
      setup.mockInput.pressEscape();
      await until((state) => state.input === undefined);
      controller.abort();
      expect(await running).toBe(0);
      expect(pasteModes).toEqual([true, false]);
    } finally {
      controller.abort();
      await running.catch(() => 0);
      await setup.dispose();
      await server.stop(true);
    }
  });
});
