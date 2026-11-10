import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewAction, ViewObject } from "@operad-io/engine";
import { fuzzyScore, matchPositions, paletteEntries } from "../src/actions.ts";
import { loadRecent, saveRecent, stateFile } from "../src/recent.ts";
import { initialState, reduce, type TuiState, type TuiStateEvent } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";
import { BUILTIN_THEMES } from "../src/theme.ts";

function action(name: string): ViewAction {
  const [plugin = "", short = ""] = name.split(":");
  return { plugin, action: short, on: "item", name, noteRequired: false, confirm: false };
}

const NAMES = ["dev:concurrency", "dev:rework", "dev:merge", "dev:mergeback", "dev:forecast", "ops:reconcile", "ops:cancel"];

function opened(): TuiState {
  let state = initialState({ width: 120, height: 40 });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  state = reduce(state, {
    type: "rows",
    tabId: "plugin:item",
    rows: [{ id: "item:one", title: "One", state: "new", waiting: false, running: false }],
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  const object: ViewObject = {
    id: "item:one",
    type: "item",
    link: "x",
    row: { id: "item:one", title: "One", state: "new", waiting: false, running: false },
    sections: [],
    actions: NAMES.map(action),
  };
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

const search = (query: string, state: TuiState = opened()) =>
  paletteEntries(press(state, ":", ...typeText(query)));

describe("palette search: query to first entry", () => {
  const table: readonly [string, string | undefined][] = [
    ["conc dev", "dev:concurrency"],
    ["dev conc", "dev:concurrency"],
    ["CONC", "dev:concurrency"],
    // A word start beats a match in the middle of a word.
    ["rec", "ops:reconcile"],
    ["can", "ops:cancel"],
    ["merge", "dev:merge"],
    ["mb", "dev:mergeback"],
    // After the colon counts as a word start.
    ["rew", "dev:rework"],
    // A group word filters.
    ["ops rec", "ops:reconcile"],
    ["tui quit", "quit"],
    ["zzz", undefined],
  ];
  for (const [query, first] of table) {
    test(`${JSON.stringify(query)} finds ${first ?? "nothing"} first`, () => {
      expect(search(query)[0]?.name).toBe(first);
    });
  }

  test("a group word keeps only the entries of that group", () => {
    const entries = search("tui help");
    expect(entries.map((entry) => entry.name)).toEqual(["help"]);
    expect(search("dev rework").map((entry) => entry.name)).toEqual(["dev:rework"]);
  });

  test("equal scores keep the order the entries were listed in", () => {
    const names = search("dev:mer").map((entry) => entry.name);
    expect(names.slice(0, 2)).toEqual(["dev:merge", "dev:mergeback"]);
    const listed = paletteEntries(press(opened(), ":")).map((entry) => entry.name);
    const found = search("e").filter((entry) => entry.group === "actions");
    for (let i = 1; i < found.length; i++) {
      const before = found[i - 1];
      const after = found[i];
      if (before === undefined || after === undefined) continue;
      if (fuzzyScore("e", before.name) !== fuzzyScore("e", after.name)) continue;
      expect(listed.indexOf(before.name)).toBeLessThan(listed.indexOf(after.name));
    }
  });
});

describe("palette search: highlight positions", () => {
  const entry = (name: string) => {
    const found = paletteEntries(press(opened(), ":")).find((one) => one.name === name);
    if (found === undefined) throw new Error(name);
    return found;
  };
  test("the matched characters of the name, over all words", () => {
    expect(matchPositions("conc dev", entry("dev:concurrency"))).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(matchPositions("rec", entry("ops:reconcile"))).toEqual([4, 5, 6]);
    expect(matchPositions("mb", entry("dev:mergeback"))).toEqual([4, 9]);
    expect(matchPositions("", entry("dev:merge"))).toEqual([]);
  });
  test("a word matched only in the group or title marks nothing in the name", () => {
    expect(matchPositions("tui", entry("help"))).toEqual([]);
    expect(matchPositions("leave", entry("quit"))).toEqual([]);
  });
  test("the matched characters are drawn in the accent colour", () => {
    const state = press(opened(), ":", ...typeText("conc"));
    const overlay = drawState(state, "dark").overlay;
    const accent = BUILTIN_THEMES.dark.accent;
    const marked = overlay?.chunks.filter((c) => c.text === "conc" && c.attributes !== undefined && c.attributes !== 0);
    expect(marked?.length).toBeGreaterThan(0);
    for (const one of marked ?? []) expect(one.fg?.toInts().join(",")).toBe(drawColour(accent));
  });
});

function drawColour(hex: string): string {
  const value = hex.replace("#", "");
  const part = (at: number) => Number.parseInt(value.slice(at, at + 2), 16);
  return [part(0), part(2), part(4), 255].join(",");
}

describe("palette search: recent entries", () => {
  const run = (state: TuiState, query: string): TuiState =>
    press(state, ":", ...typeText(query), "enter");

  test("an empty query lists the last five used first, the latest first, then the group order", () => {
    let state = opened();
    const baseline = paletteEntries(press(state, ":")).map((e) => e.name);
    state = { ...state, acting: false };
    for (const query of ["help", "refresh", "dev:rework", "ops:cancel", "go to pending", "quit"]) {
      state = { ...run(state, query), actionRequest: undefined, acting: false, quit: false, keys: false };
      state = { ...state, object: opened().object };
    }
    const names = paletteEntries(press(state, ":")).map((e) => e.name);
    expect(names.slice(0, 5)).toEqual(["quit", "go to pending", "ops:cancel", "dev:rework", "refresh"]);
    const rest = baseline.filter((name) => !names.slice(0, 5).includes(name));
    expect(names.slice(5)).toEqual(rest);
    expect(state.recent).toHaveLength(5);
  });

  test("a typed query ignores the recent list", () => {
    const state = { ...opened(), recent: ["tui/quit"] };
    expect(search("dev:merge", state)[0]?.name).toBe("dev:merge");
  });

  test("an entry that no longer exists is skipped", () => {
    const state = { ...opened(), recent: ["actions/gone:away", "tui/help"] };
    expect(paletteEntries(press(state, ":"))[0]?.name).toBe("help");
  });
});

describe("the TUI's state file", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const root = (): string => {
    const made = mkdtempSync(join(tmpdir(), "tui-recent-"));
    roots.push(made);
    return made;
  };
  test("the list is written and read back; a missing or broken file is empty", () => {
    const home = root();
    expect(loadRecent(home)).toEqual([]);
    saveRecent(join(home, "sub"), ["tui/help", "tui/quit"]);
    expect(loadRecent(join(home, "sub"))).toEqual(["tui/help", "tui/quit"]);
    expect(JSON.parse(readFileSync(stateFile(join(home, "sub")), "utf8"))).toEqual({
      recent: ["tui/help", "tui/quit"],
    });
    writeFileSync(stateFile(home), "{ nope");
    expect(loadRecent(home)).toEqual([]);
    writeFileSync(stateFile(home), JSON.stringify({ recent: ["a", 3, "b", "c", "d", "e", "f"] }));
    expect(loadRecent(home)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
