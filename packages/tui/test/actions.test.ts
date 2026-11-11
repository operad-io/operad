import { describe, expect, test } from "bun:test";
import type { ViewAction, ViewObject } from "@operad-io/engine";
import {
  RESERVED_KEYS,
  actionFailed,
  entryHint,
  keyOf,
  paletteEntries,
  refusalLine,
} from "../src/actions.ts";
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
    tabId: "plugin:item",
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
    expect(footerText(state).startsWith("m tuitest:approve · : more · ")).toBe(true);
    const lone = opened([ACTIONS[3] as ViewAction]);
    expect(footerText(lone).startsWith("a other:ship · j/k")).toBe(true);
    const none = opened([]);
    expect(footerText(none).startsWith("a ")).toBe(false);
  });

  test("the palette filters by fuzzy match and shows key, note and confirm", () => {
    const state = opened(ACTIONS, [{ key: "d", action: "tuitest:drop", source: "plugin" }]);
    const open = press(state, ":");
    expect(open.input?.kind).toBe("palette");
    const own = (state: TuiState) =>
      paletteEntries(state).filter((entry) => entry.group === "actions");
    expect(own(open).map((entry) => entry.name)).toEqual(ACTIONS.map((a) => a.name));
    const filtered = press(open, ...typeText("tdrp"));
    expect(own(filtered)).toEqual([
      {
        group: "actions",
        name: "tuitest:drop",
        title: "tuitest:drop on one",
        key: "d",
        needsNote: false,
        confirm: true,
      },
    ]);
    const approve = own(press(open, ...typeText("appr")))[0];
    expect(approve).toMatchObject({ needsNote: true, confirm: false });
    expect(paletteEntries(press(open, ...typeText("zzz")))).toEqual([]);
    const back = press(filtered, "backspace", "backspace", "backspace");
    expect(own(back).length).toBeGreaterThan(1);
    expect(press(open, "escape").input).toBeUndefined();
  });

  test("with no object the palette lists the TUI commands", () => {
    const state = press(initialState({ width: 120 }), ":");
    expect(state.input?.kind).toBe("palette");
    const entries = paletteEntries(state);
    expect(entries.map((entry) => entry.group)).toEqual(entries.map(() => "tui"));
    expect(entries.map((entry) => entry.name)).toEqual([
      "help", "refresh", "go to pending", "go to running", "theme", "go back", "quit",
    ]);
    for (const entry of entries) expect(entry.title.length).toBeGreaterThan(0);
  });

  test("groups are shown in the order actions, tui; search reads the title", () => {
    const open = press(opened(), ":");
    const groups = paletteEntries(open).map((entry) => entry.group);
    expect(groups).toEqual([...groups].sort((a, b) => (a === b ? 0 : a === "actions" ? -1 : 1)));
    expect(groups[0]).toBe("actions");
    expect(groups.at(-1)).toBe("tui");
    // "leave" is only in the title of quit.
    expect(paletteEntries(press(open, ...typeText("leave"))).map((e) => e.name)).toEqual(["quit"]);
    // A query that matches in both groups lists actions first.
    const both = paletteEntries(press(open, ...typeText("e"))).map((entry) => entry.group);
    expect(both[0]).toBe("actions");
    expect(both.at(-1)).toBe("tui");
  });

  test("a go-to entry exists for every type the server lists", () => {
    const state = press(opened(), ":");
    expect(paletteEntries(state).map((e) => e.name)).toContain("go to Item");
  });

  describe("each TUI command does what its key does", () => {
    const run = (state: TuiState, name: string): TuiState => {
      let open = press(state, ":", ...typeText(name));
      const at = paletteEntries(open).findIndex((entry) => entry.name === name);
      expect(at).toBeGreaterThanOrEqual(0);
      open = press(open, ...Array.from({ length: at }, () => "down"), "enter");
      return open;
    };
    const idle = (): TuiState =>
      reduce(initialState({ width: 120 }), { type: "types", types: [{ type: "item", title: "Item" }] });

    test("help shows the key list", () => {
      const state = run(idle(), "help");
      expect(state.input).toBeUndefined();
      expect(state.keys).toBe(press(idle(), "?").keys);
      expect(state.keys).toBe(true);
    });

    test("refresh asks for the lists again", () => {
      const state = run(idle(), "refresh");
      expect(state.refreshRequested).toBe(true);
      expect(state.input).toBeUndefined();
    });

    test("go to pending, running and a type's list switch the tab, as 1, 2 and 3 do", () => {
      const start = press(idle(), "3");
      expect(start.active).toBe(2);
      expect(run(start, "go to running").active).toBe(press(start, "2").active);
      expect(run(start, "go to pending").active).toBe(0);
      expect(run(press(idle(), "1"), "go to Item").active).toBe(press(idle(), "3").active);
      expect(run(press(idle(), "1"), "go to Item").active).toBe(2);
    });

    test("go back closes the open object, as escape does", () => {
      const state = opened();
      expect(state.object).toBeDefined();
      const back = run(state, "go back");
      expect(back.object).toBeUndefined();
      expect(back.object).toEqual(press(state, "escape").object);
    });

    test("quit leaves, as q does", () => {
      expect(run(idle(), "quit").quit).toBe(true);
    });
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

  test("the main key never runs a confirm action, one that ends the object included, without its [y/N]", () => {
    const ends = action("tuitest:end", { confirm: true });
    const state = press(opened([ends, action("other:ship")]), "a");
    expect(state.actionRequest).toBeUndefined();
    expect(state.input).toMatchObject({ kind: "confirm", action: "tuitest:end" });
    expect(press(state, "n").actionRequest).toBeUndefined();
    expect(press(state, "y").actionRequest).toMatchObject({ action: "tuitest:end", confirmed: true });
  });

  test("the main key skips an action that ends the object, and says none is available when only it is left", () => {
    const ends = action("tuitest:end", { confirm: true, ends: true });
    const first = press(opened([ends, action("other:ship")]), "a");
    expect(first.actionRequest).toMatchObject({ action: "other:ship" });
    const alone = press(opened([ends]), "a");
    expect(alone.actionRequest).toBeUndefined();
    expect(alone.input).toBeUndefined();
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

  test("a refusal shows the line without the status until the next key", () => {
    let state = press(opened(), "a", ...typeText("ok"), "enter");
    expect(state.acting).toBe(true);
    state = reduce(state, { type: "action-launched" });
    expect(state.actionRequest).toBeUndefined();
    const message = "item one: already approved by someone else";
    state = reduce(state, { type: "action-error", status: 409, message });
    expect(noticeText(state)).toBe(message);
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

describe("a refusal line", () => {
  test("drops a status number and keeps the sentence, even one that starts like a field", () => {
    const line = 'T-0114-x is in draft plan P-0018-y; confirm the plan first (dev:confirm P-0018-y)';
    expect(refusalLine(`422 ${line}`)).toBe(line);
    expect(refusalLine(`connect: ${line}`)).toBe(`connect: ${line}`);
    expect(refusalLine(line)).toBe(line);
    const state = actionFailed(opened(), `422 ${line}`);
    expect(noticeText(state)).toBe(line);
  });

  test("a result that was already true shows its line and ends the wait", () => {
    const sent = press(opened(), "a", ...typeText("ok"), "enter");
    const done = reduce(sent, { type: "action-done", notice: "T-0001-one is already cancelled; nothing to do" });
    expect(done.acting).toBe(false);
    expect(noticeText(done)).toBe("T-0001-one is already cancelled; nothing to do");
  });
});
