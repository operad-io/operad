import { describe, expect, test } from "bun:test";
import type { ViewAction, ViewObject } from "@operad-io/engine";
import {
  chatCommands,
  commandEntries,
  commandHint,
  commandOptions,
  type TuiChatCommand,
} from "../src/commands.ts";
import { paletteEntries } from "../src/actions.ts";
import { initialState, reduce, type TuiState, type TuiStateEvent } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";

const NOTE = { type: "string", role: "note" } as const;

function action(name: string, extra: Partial<ViewAction> = {}): ViewAction {
  const [plugin = "", short = ""] = name.split(":");
  return { plugin, action: short, on: "chat", name, noteRequired: false, confirm: false, ...extra };
}

const SEND = action("chat:send", {
  args: { type: "object", properties: { note: NOTE }, additionalProperties: false },
  note: "note",
});
const MODEL = action("chat:model", {
  command: "Change the model the next reply uses.",
  args: {
    type: "object",
    properties: { model: { type: "string", enum: ["sonnet", "opus"], description: "The model." } },
    required: ["model"],
  },
});
const EFFORT = action("chat:effort", {
  command: "Change the effort the next reply uses.",
  args: {
    type: "object",
    properties: { effort: { type: "string", enum: ["low", "high"] } },
    required: ["effort"],
  },
});
const STOP = action("chat:stop", { command: "Stop the reply being written." });
const HELP = action("chat:help", { command: "List what can be typed here." });

const ACTIONS = [SEND, MODEL, EFFORT, STOP, HELP];

function opened(actions: readonly ViewAction[] = ACTIONS): TuiState {
  const row = { id: "chat:one", title: "One", state: "open", waiting: false, running: false };
  const object: ViewObject = {
    id: "chat:one",
    type: "chat",
    link: "x",
    row,
    sections: [],
    actions,
  };
  let state = initialState({ width: 120 });
  state = reduce(state, { type: "types", types: [{ type: "chat", title: "Chat" }] });
  state = reduce(state, { type: "rows", tabId: "plugin:chat", rows: [row] });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  return reduce(state, { type: "object", object });
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

/** The chat's send action opened its note input, which is this chat's input. */
function input(): TuiState {
  const state = press(opened(), "a");
  expect(state.input?.kind).toBe("note");
  return state;
}

const names = (entries: readonly TuiChatCommand[]): string[] => entries.map((entry) => entry.name);

describe("a chat's input lists its commands on /", () => {
  test("the list is every action that declares a command, with its description and hint", () => {
    const state = press(input(), "/");
    expect(state.input?.kind).toBe("note");
    expect(state.input?.kind === "note" && state.input.text).toBe("/");
    const entries = commandEntries(state);
    expect(names(entries)).toEqual(["model", "effort", "stop", "help"]);
    expect(entries[0]?.slash).toBe("/model");
    expect(entries[0]?.description).toBe("Change the model the next reply uses.");
    expect(entries[0]?.hint).toContain("model: sonnet, opus");
    expect(entries[3]?.hint).toBe("");
    // `/` on the chat page opens the same list without a key first.
    const direct = press(opened(), "/");
    expect(direct.input?.kind).toBe("note");
    expect(direct.input?.kind === "note" && direct.input.text).toBe("/");
    expect(direct.input?.kind === "note" && direct.input.commandMenu?.cursor).toBe(0);
    expect(names(commandEntries(direct))).toEqual(["model", "effort", "stop", "help"]);
  });

  test("typing after the slash filters the list and the arrows move in it", () => {
    const state = press(input(), "/", ...typeText("mo"));
    expect(state.input?.kind === "note" && state.input.text).toBe("/mo");
    expect(names(commandEntries(state))).toEqual(["model"]);
    const empty = press(input(), "/", ...typeText("zzz"));
    expect(commandEntries(empty)).toEqual([]);
    const both = press(input(), "/", ...typeText("e"));
    expect(names(commandEntries(both))).toEqual(["effort"]);
    const moved = press(both, "down");
    expect(moved.input?.kind === "note" && moved.input.commandMenu?.cursor).toBe(0);
  });

  test("the arrows move in the list and stop at its ends", () => {
    let state = press(input(), "/");
    for (let step = 0; step < 9; step += 1) state = press(state, "down");
    expect(state.input?.kind === "note" && state.input.commandMenu?.cursor).toBe(3);
    for (let step = 0; step < 9; step += 1) state = press(state, "up");
    expect(state.input?.kind === "note" && state.input.commandMenu?.cursor).toBe(0);
  });

  test("escape closes only the list; another escape closes the input", () => {
    const listed = press(input(), "/", ...typeText("mod"));
    expect(listed.input?.kind === "note" && listed.input.commandMenu).toBeDefined();
    const closed = press(listed, "escape");
    expect(closed.input?.kind).toBe("note");
    expect(closed.input?.kind === "note" && closed.input.text).toBe("/mod");
    expect(closed.input?.kind === "note" && closed.input.commandMenu).toBeUndefined();
    expect(press(closed, "escape").input).toBeUndefined();
  });

  test("Enter fills the line with the chosen command and does not run it", () => {
    const listed = press(input(), "/", ...typeText("sto"));
    const filled = press(listed, "enter");
    expect(filled.actionRequest).toBeUndefined();
    expect(filled.input?.kind === "note" && filled.input.text).toBe("/stop");
    expect(filled.input?.kind === "note" && filled.input.commandMenu).toBeUndefined();
    expect(press(filled, "enter").actionRequest).toEqual({
      action: "chat:send",
      id: "chat:one",
      note: "/stop",
    });
  });

  test("Enter sends a line that already spells the chosen command", () => {
    const state = press(input(), "/", ...typeText("stop"), "enter");
    expect(state.actionRequest).toEqual({
      action: "chat:send",
      id: "chat:one",
      note: "/stop",
    });
  });

  test("/ opens chat:send even when another note action is declared first", () => {
    const OTHER_NOTE = action("chat:other", {
      args: { type: "object", properties: { note: NOTE }, additionalProperties: false },
      note: "note",
    });
    const state = press(opened([OTHER_NOTE, SEND, ...ACTIONS.slice(1)]), "/");
    expect(state.input?.kind).toBe("note");
    expect(state.input?.kind === "note" && state.input.action).toBe("chat:send");
    expect(state.input?.kind === "note" && state.input.text).toBe("/");
  });

  test("a clashing short name keeps it for the chat plugin and gives the other its plugin name", () => {
    const other = action("other:model", { command: "Another model." });
    const alpha = action("alpha:stop", { command: "Alpha stop." });
    const beta = action("beta:stop", { command: "Beta stop." });
    expect(chatCommands([MODEL, other]).map((command) => command.name)).toEqual([
      "model",
      "other_model",
    ]);
    expect(chatCommands([alpha, beta]).map((command) => command.name)).toEqual([
      "alpha_stop",
      "beta_stop",
    ]);
  });

  test("a choice parameter shows its options; choosing the command fills the input", () => {
    const listed = press(input(), "/", ...typeText("mod"));
    const model = commandEntries(listed)[0];
    expect(model).toBeDefined();
    if (model === undefined) return;
    expect(commandOptions(model).map((option) => option.label)).toEqual(["sonnet", "opus"]);
    expect(commandHint(model)).toContain("sonnet");
    // Choosing fills the line; it does not run the action.
    const chosen = press(listed, "enter");
    expect(chosen.actionRequest).toBeUndefined();
    expect(chosen.input?.kind === "note" && chosen.input.text).toBe("/model ");
    expect(chosen.input?.kind === "note" && chosen.input.commandMenu).toBeUndefined();
    // Sending goes through chat:send as one line of text.
    const sent = press(chosen, ...typeText("sonnet"), "enter");
    expect(sent.actionRequest).toEqual({
      action: "chat:send",
      id: "chat:one",
      note: "/model sonnet",
    });
  });

  test("a path-like word with no command is sent as written", () => {
    const state = press(input(), "/", ...typeText("usr"));
    expect(state.input?.kind === "note" && state.input.text).toBe("/usr");
    expect(commandEntries(state)).toEqual([]);
    const sent = press(state, "enter");
    expect(sent.actionRequest).toEqual({
      action: "chat:send",
      id: "chat:one",
      note: "/usr",
    });
  });

  test("the open list is drawn with its names, descriptions and choices", () => {
    const state = press(input(), "/", ...typeText("mod"));
    const overlay = drawState(state, "dark").overlay;
    const text = overlay?.chunks.map((part) => part.text).join("") ?? "";
    expect(text).toContain("/model");
    expect(text).toContain("Change the model the next reply uses.");
    expect(text).toContain("sonnet");
    expect(text).toContain("/mod");
  });

  test("the : palette still lists actions, not the slash list", () => {
    const entries = paletteEntries(press(opened(), ":"));
    expect(entries.some((entry) => entry.name === "chat:send")).toBe(true);
    expect(entries.some((entry) => entry.name === "/model")).toBe(false);
    expect(chatCommands(ACTIONS).map((command) => command.slash)).toEqual([
      "/model", "/effort", "/stop", "/help",
    ]);
  });
});
