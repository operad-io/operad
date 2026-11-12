import { describe, expect, test } from "bun:test";
import type { ViewAction, ViewObject } from "@operad-io/engine";
import { entryHint, paletteEntries } from "../src/actions.ts";
import { initialState, reduce, type TuiState, type TuiStateEvent } from "../src/state.ts";

const LEVEL = { type: "string", enum: ["off", "run", "merge"], description: "how far it goes alone" } as const;
const HARNESS = { type: "string", enum: ["claude", "pi"] } as const;
const COUNT = { type: "integer", minimum: 1, maximum: 16 } as const;
const NOTE = { type: "string", role: "note" } as const;

function action(name: string, extra: Partial<ViewAction>): ViewAction {
  const [plugin = "", short = ""] = name.split(":");
  return { plugin, action: short, on: "item", name, noteRequired: false, confirm: false, ...extra };
}

const ACTIONS: readonly ViewAction[] = [
  action("devtest:auto", {
    args: { type: "object", properties: { level: LEVEL }, required: ["level"] },
  }),
  action("devtest:concurrency", {
    args: { type: "object", properties: { count: COUNT }, required: ["count"] },
  }),
  action("devtest:pause", {
    args: { type: "object", properties: { hold: { type: "boolean", default: false } }, required: ["hold"] },
  }),
  action("devtest:both", {
    args: { type: "object", properties: { level: LEVEL, count: COUNT, why: NOTE }, required: ["level", "count", "why"] },
    note: "why",
    noteRequired: true,
  }),
];

function opened(state: string = "run", badge?: string, actions: readonly ViewAction[] = ACTIONS): TuiState {
  const object: ViewObject = {
    id: "item:one",
    type: "item",
    link: "x",
    row: { id: "item:one", title: "One", state, waiting: false, running: false, ...(badge === undefined ? {} : { badge }) },
    sections: [],
    actions,
  };
  let s = initialState({ width: 120 });
  s = reduce(s, { type: "types", types: [{ type: "item", title: "Item" }] });
  s = reduce(s, {
    type: "rows",
    tabId: "plugin:item",
    rows: [object.row],
  });
  s = reduce(s, { type: "key", key: "3" });
  s = reduce(s, { type: "key", key: "enter" });
  return reduce(s, { type: "object", object });
}

function press(state: TuiState, ...keys: (string | TuiStateEvent)[]): TuiState {
  let next = state;
  for (const key of keys) {
    next =
      typeof key === "string"
        ? reduce(next, { type: "key", key, ...(key.length === 1 ? { text: key } : {}) })
        : reduce(next, key);
  }
  return next;
}

const typeText = (text: string): string[] => [...text];

describe("arguments of an action", () => {
  test("an enum is a list with the current value preselected; enter sends the pick", () => {
    let state = press(opened("run"), ":", ...typeText("auto"), "enter");
    expect(state.input?.kind).toBe("args");
    if (state.input?.kind !== "args") return;
    expect(state.input.fields[0]?.options.map((o) => o.label)).toEqual(["off", "run", "merge"]);
    expect(state.input.cursor).toBe(1);
    expect(state.input.fields[0]?.current).toBe(1);
    state = press(state, "j", "enter");
    expect(state.actionRequest).toEqual({ action: "devtest:auto", id: "item:one", args: { level: "merge" } });
  });

  test("an optional enum is a choice that starts unset; an optional text is not asked", () => {
    const chat = action("devtest:chat", {
      args: {
        type: "object",
        properties: { harness: HARNESS, title: { type: "string" } },
        additionalProperties: false,
      },
    });
    const open = (): TuiState =>
      press(opened("run", undefined, [chat]), ":", ...typeText("devtest:chat"), "enter");
    const state = open();
    expect(state.input?.kind).toBe("args");
    if (state.input?.kind !== "args") return;
    expect(state.input.fields.map((field) => field.name)).toEqual(["harness"]);
    expect(state.input.fields[0]?.options.map((o) => o.label)).toEqual(["claude", "pi"]);
    expect(state.input.cursor).toBe(-1);
    // Enter without a pick leaves the harness out, so the run uses the first loaded one.
    expect(press(state, "enter").actionRequest).toEqual({
      action: "devtest:chat",
      id: "item:one",
    });
    expect(press(open(), "j", "j", "enter").actionRequest).toEqual({
      action: "devtest:chat",
      id: "item:one",
      args: { harness: "pi" },
    });
  });

  test("a row's badge marks the current level, so a plugin that badges its level needs no client code", () => {
    const state = press(opened("confirmed", "merge"), ":", ...typeText("auto"), "enter");
    expect(state.input?.kind === "args" && state.input.cursor).toBe(2);
  });

  test("without a current value the list starts on the first value", () => {
    const state = press(opened("new"), ":", ...typeText("auto"), "enter");
    expect(state.input?.kind === "args" && state.input.cursor).toBe(0);
  });

  test("an integer outside its bounds is refused locally; one inside is sent", () => {
    let state = press(opened(), ":", ...typeText("concurrency"), "enter");
    state = press(state, ...typeText("17"), "enter");
    expect(state.actionRequest).toBeUndefined();
    expect(state.input?.kind === "args" && state.input.error).toBe("count: a whole number from 1 to 16");
    state = press(state, "backspace", "backspace", "0", "enter");
    expect(state.actionRequest).toBeUndefined();
    state = press(state, "backspace", ...typeText("3"), "enter");
    expect(state.actionRequest).toEqual({ action: "devtest:concurrency", id: "item:one", args: { count: 3 } });
  });

  test("typed values after the action name fill the first argument", () => {
    const merge = press(opened(), ":", ...typeText("devtest:auto merge"), "enter");
    expect(merge.actionRequest).toEqual({ action: "devtest:auto", id: "item:one", args: { level: "merge" } });
    const three = press(opened(), ":", ...typeText("concurrency 3"), "enter");
    expect(three.actionRequest?.args).toEqual({ count: 3 });
  });

  test("a typed value that does not fit shows the allowed values and sends nothing", () => {
    let state = press(opened(), ":", ...typeText("devtest:auto nope"));
    const entry = paletteEntries(state).find((e) => e.name === "devtest:auto");
    expect(entry).toBeDefined();
    expect(entry === undefined ? "" : entryHint(entry)).toBe("level: off, run, merge");
    state = press(state, "enter");
    expect(state.actionRequest).toBeUndefined();
    expect(state.input?.kind).toBe("palette");
    const big = press(opened(), ":", ...typeText("concurrency 99"));
    expect(paletteEntries(big)[0]?.refusal).toBe("count: a whole number from 1 to 16");
  });

  test("the rest of the arguments are asked in order, then the note, then the request", () => {
    let state = press(opened(), ":", ...typeText("both off"), "enter");
    expect(state.input?.kind === "args" && state.input.at).toBe(1);
    state = press(state, "5", "enter");
    expect(state.input?.kind).toBe("note");
    state = press(state, ...typeText("because"), "enter");
    expect(state.actionRequest).toEqual({
      action: "devtest:both",
      id: "item:one",
      note: "because",
      args: { level: "off", count: 5 },
    });
  });

  test("esc cancels without sending", () => {
    const state = press(opened(), ":", ...typeText("auto"), "enter", "j", "escape");
    expect(state.input).toBeUndefined();
    expect(state.actionRequest).toBeUndefined();
    expect(state.acting).toBe(false);
  });

  test("a boolean is a yes/no list that starts on its default", () => {
    let state = press(opened(), ":", ...typeText("pause"), "enter");
    expect(state.input?.kind === "args" && state.input.fields[0]?.options.map((o) => o.label)).toEqual(["yes", "no"]);
    expect(state.input?.kind === "args" && state.input.cursor).toBe(1);
    state = press(state, "k", "enter");
    expect(state.actionRequest).toEqual({ action: "devtest:pause", id: "item:one", args: { hold: true } });
  });

  test("a yes or no typed in the palette fills a boolean; anything else is refused", () => {
    const yes = press(opened(), ":", ...typeText("devtest:pause yes"), "enter");
    expect(yes.actionRequest?.args).toEqual({ hold: true });
    const no = press(opened(), ":", ...typeText("devtest:pause n"), "enter");
    expect(no.actionRequest?.args).toEqual({ hold: false });
    const bad = press(opened(), ":", ...typeText("devtest:pause maybe"));
    expect(paletteEntries(bad)[0]?.refusal).toBe("hold: yes, no");
  });
});
