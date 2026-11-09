import { describe, expect, test } from "bun:test";
import type { ViewAction, ViewObject } from "@operad-io/engine";
import { RESERVED_KEYS, entryHint, keyOf, paletteEntries } from "../src/actions.ts";
import {
  footerText,
  initialState,
  noticeText,
  reduce,
  type TuiBinding,
  type TuiState,
  type TuiStateEvent,
} from "../src/state.ts";

function action(name: string, extra: Partial<ViewAction> = {}): ViewAction {
  const [plugin = "", short = ""] = name.split(":");
  return { plugin, action: short, on: "item", name, noteRequired: false, confirm: false, ...extra };
}

const ACTIONS: readonly ViewAction[] = [
  action("tuitest:approve", { note: "note", noteRequired: true }),
  action("tuitest:drop", { confirm: true }),
  action("tuitest:label", { note: "note" }),
  action("other:ship"),
];

function objectView(actions: readonly ViewAction[]): ViewObject {
  return {
    id: "item:one",
    type: "item",
    link: "x",
    row: { id: "item:one", title: "One", state: "new", waiting: false, running: false },
    sections: [],
    actions,
  };
}

function opened(
  actions: readonly ViewAction[] = ACTIONS,
  bindings: readonly TuiBinding[] = [],
): TuiState {
  let state = initialState({ width: 120 });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  state = reduce(state, {
    type: "rows",
    tabId: "type:item",
    rows: [{ id: "item:one", title: "One", state: "new", waiting: false, running: false }],
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, { type: "object", object: objectView(actions) });
  return reduce(state, { type: "keys", bindings });
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

const typeText = (text: string): TuiStateEvent[] =>
  [...text].map((char) => ({ type: "key", key: char === " " ? "space" : char, text: char }));

describe("actions in the reducer", () => {
  test("the footer offers the first action under its bound key and the rest under :", () => {
    const state = opened(ACTIONS, [{ key: "m", action: "tuitest:approve", source: "plugin" }]);
    expect(footerText(state).startsWith("m tuitest:approve  : more  ")).toBe(true);
    const lone = opened([ACTIONS[3] as ViewAction]);
    expect(footerText(lone).startsWith("a other:ship  j/k")).toBe(true);
    const none = opened([]);
    expect(footerText(none).startsWith("a ")).toBe(false);
  });

  test("the palette filters by fuzzy match and shows key, note and confirm", () => {
    const state = opened(ACTIONS, [{ key: "d", action: "tuitest:drop", source: "plugin" }]);
    const open = press(state, ":");
    expect(open.input?.kind).toBe("palette");
    expect(paletteEntries(open).map((entry) => entry.name)).toEqual(ACTIONS.map((a) => a.name));
    const filtered = press(open, ...typeText("tdrp"));
    expect(paletteEntries(filtered)).toEqual([
      { name: "tuitest:drop", key: "d", needsNote: false, confirm: true },
    ]);
    const approve = paletteEntries(press(open, ...typeText("appr")))[0];
    expect(approve).toMatchObject({ needsNote: true, confirm: false });
    expect(paletteEntries(press(open, ...typeText("zzz")))).toEqual([]);
    const back = press(filtered, "backspace", "backspace", "backspace");
    expect(paletteEntries(back).length).toBeGreaterThan(1);
    expect(press(open, "escape").input).toBeUndefined();
  });

  test("with no object the palette lists nothing", () => {
    const state = press(initialState({ width: 120 }), ":");
    expect(state.input?.kind).toBe("palette");
    expect(paletteEntries(state)).toEqual([]);
  });

  test("Enter in the palette runs the highlighted entry; arrows move", () => {
    let state = press(opened(), ":", ...typeText("e"));
    // approve, drop, label and ship all contain e; ship ranks by position.
    const second = paletteEntries(state)[1];
    state = press(state, "down");
    state = press(state, "enter");
    expect(state.input).toMatchObject({ kind: second?.name === "tuitest:drop" ? "confirm" : "note" });
  });

  test("a bound key runs its action; a user binding beats the plugin's and the built-in keys", () => {
    const plugin: TuiBinding = { key: "m", action: "tuitest:approve", source: "plugin" };
    const user: TuiBinding = { key: "m", action: "other:ship", source: "user" };
    const state = opened(ACTIONS, [plugin, user]);
    const ran = press(state, "m");
    expect(ran.actionRequest).toEqual({ action: "other:ship", id: "item:one" });
    expect(ran.acting).toBe(true);
    expect(press(opened(ACTIONS, [plugin]), "m").input?.kind).toBe("note");
  });

  test("reserved keys are dropped from the bindings, announced once, and keep their built-in use", () => {
    const dropped: TuiBinding[] = [
      { key: "j", action: "other:ship", source: "plugin" },
      { key: "enter", action: "other:ship", source: "user" },
    ];
    const state = opened(ACTIONS, dropped);
    expect(state.bindings).toEqual([]);
    expect(state.notice).toContain("j (other:ship, plugin)");
    expect(state.notice).toContain("enter (other:ship, user)");
    const ship = ACTIONS.find((action) => action.name === "other:ship") as ViewAction;
    expect(keyOf(state.bindings, ship)).toBe(ship.key);
    expect(entryHint(paletteEntries(state).find((e) => e.name === "other:ship") as never)).not.toContain("enter");
    expect(press(state, "j").actionRequest).toBeUndefined();
    const pressed = press(state, "enter");
    expect(pressed.actionRequest).toBeUndefined();
  });

  test("every reserved key is dropped whatever its source", () => {
    for (const key of RESERVED_KEYS) {
      const state = opened(ACTIONS, [{ key, action: "other:ship", source: "user" }]);
      expect(state.bindings).toEqual([]);
    }
  });

  test("the page keys p, n and N are reserved", () => {
    for (const key of ["p", "n", "N", "P"]) {
      const state = opened(ACTIONS, [{ key, action: "other:ship", source: "user" }]);
      expect(state.bindings).toEqual([]);
    }
  });

  test("every key keyOf advertises runs its action through handleKey", () => {
    const bindings: TuiBinding[] = [
      { key: "m", action: "tuitest:approve", source: "plugin" },
      { key: "x", action: "other:ship", source: "plugin" },
      { key: "x", action: "tuitest:drop", source: "user" },
      { key: "a", action: "tuitest:drop", source: "plugin" },
      { key: "r", action: "tuitest:approve", source: "plugin" },
    ];
    const state = opened(ACTIONS, bindings);
    for (const action of state.object?.actions ?? []) {
      const key = keyOf(state.bindings, action);
      if (key === undefined) continue;
      const ran = press(state, key);
      const started = ran.actionRequest?.action ?? (ran.input !== undefined && "action" in ran.input ? ran.input.action : undefined);
      expect(started).toBe(action.name);
    }
  });

  test("a reserved plugin default is not advertised from the action's own key", () => {
    const withKey = ACTIONS.map((a) => (a.name === "other:ship" ? { ...a, key: "j" } : a));
    const state = opened(withKey, [{ key: "j", action: "other:ship", source: "plugin" }]);
    const ship = state.object?.actions.find((a) => a.name === "other:ship") as ViewAction;
    expect(keyOf(state.bindings, ship)).toBeUndefined();
  });

  test("a bound a is not advertised as the main action's key", () => {
    const state = opened(ACTIONS, [{ key: "a", action: "tuitest:drop", source: "user" }]);
    expect(footerText(state)).not.toContain("a tuitest:approve");
    expect(press(state, "a").input).toMatchObject({ kind: "confirm", action: "tuitest:drop" });
  });

  test("Ctrl and Meta chords are dropped as reserved", () => {
    const state = opened(ACTIONS, [
      { key: "ctrl-x", action: "other:ship", source: "user" },
      { key: "meta-x", action: "other:ship", source: "plugin" },
    ]);
    expect(state.bindings).toEqual([]);
  });

  test("a note is sent exactly as entered", () => {
    let state = press(opened(), "a");
    state = press(state, ...typeText("  reason  "), { type: "key", key: "enter", shift: true }, "enter");
    expect(state.actionRequest?.note).toBe("  reason  \n");
  });

  test("an optional note of only whitespace is sent as entered", () => {
    const lone = opened([ACTIONS[2] as ViewAction]);
    const spaces = press(lone, "a", ...typeText("  "), "enter");
    expect(spaces.actionRequest?.note).toBe("  ");
    const lines = press(lone, "a", { type: "key", key: "enter", shift: true }, "enter");
    expect(lines.actionRequest?.note).toBe("\n");
  });

  test("a key the object does not offer now says so in one footer line", () => {
    const bound = opened([ACTIONS[3] as ViewAction], [
      { key: "m", action: "tuitest:approve", source: "plugin" },
    ]);
    const refused = press(bound, "m");
    expect(refused.actionRequest).toBeUndefined();
    expect(noticeText(refused)).toBe("tuitest:approve is not available for one");
    expect(noticeText(press(refused, "x"))).toBeUndefined();
  });

  test("a note action refuses to send while a required note is empty", () => {
    let state = press(opened(), "a");
    expect(state.input).toMatchObject({ kind: "note", action: "tuitest:approve", required: true });
    state = press(state, "enter");
    expect(state.actionRequest).toBeUndefined();
    expect(state.input?.kind).toBe("note");
    expect(noticeText(state)).toBe("a note is required");
    state = press(state, "space", "space", "enter");
    expect(state.actionRequest).toBeUndefined();
    state = press(state, ...typeText("looks good"), { type: "key", key: "enter", shift: true });
    state = press(state, ...typeText("ship it"), "enter");
    expect(state.actionRequest).toEqual({
      action: "tuitest:approve",
      id: "item:one",
      note: "looks good\nship it",
    });
    expect(state.input).toBeUndefined();
  });

  test("an optional note may be sent empty, and escape cancels", () => {
    const state = press(opened([ACTIONS[2] as ViewAction]), "a");
    expect(press(state, "escape").input).toBeUndefined();
    expect(press(state, "enter").actionRequest).toEqual({ action: "tuitest:label", id: "item:one" });
  });

  test("a confirm action asks and only y sends, with confirmed", () => {
    const asked = press(opened([ACTIONS[1] as ViewAction]), "a");
    expect(noticeText(asked)).toBe("tuitest:drop one? [y/N]");
    for (const no of ["n", "enter", "escape", "x"]) {
      const answered = press(asked, no);
      expect(answered.actionRequest).toBeUndefined();
      expect(answered.input).toBeUndefined();
    }
    const yes = press(asked, "y");
    expect(yes.actionRequest).toEqual({ action: "tuitest:drop", id: "item:one", confirmed: true });
  });

  test("a note on a confirm action is asked first and travels with the confirmation", () => {
    const both = action("tuitest:reject", { note: "note", confirm: true });
    let state = press(opened([both]), "a", ...typeText("no"), "enter");
    expect(state.input?.kind).toBe("confirm");
    state = press(state, "y");
    expect(state.actionRequest).toEqual({
      action: "tuitest:reject",
      id: "item:one",
      note: "no",
      confirmed: true,
    });
  });

  test("a refusal shows the server's status and message until the next key", () => {
    let state = press(opened(), "a", ...typeText("ok"), "enter");
    expect(state.acting).toBe(true);
    state = reduce(state, { type: "action-launched" });
    expect(state.actionRequest).toBeUndefined();
    const message = "item one: already approved by someone else";
    state = reduce(state, { type: "action-error", status: 409, message });
    expect(noticeText(state)).toBe(`409 ${message}`);
    expect(state.acting).toBe(false);
    expect(footerText(state)).toContain("tuitest:approve");
    expect(noticeText(press(state, "j"))).toBeUndefined();
  });

  test("a second action waits while one is on its way", () => {
    const sent = press(opened(), "a", ...typeText("ok"), "enter");
    const second = press(sent, ":", ...typeText("ship"), "enter");
    expect(second.actionRequest).toEqual(sent.actionRequest);
    expect(noticeText(second)).toBe("the last action has not answered yet");
    expect(reduce(sent, { type: "action-done" }).acting).toBe(false);
  });
});
