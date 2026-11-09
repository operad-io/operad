import { describe, expect, test } from "bun:test";
import type { ViewObject, ViewRow } from "@operad-io/engine";
import {
  activeSection,
  initialState,
  pageEntries,
  pagePosition,
  reduce,
  type TuiState,
} from "../src/state.ts";
import { KEY_LIST } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";

const TOC = [
  { label: "overview" },
  { label: "docs/manual.md", cursor: "1" },
  { label: "src/main.ts", cursor: "2" },
  { label: "README.md", cursor: "3" },
] as const;

function row(id: string): ViewRow {
  return { id, title: `Title ${id}`, state: "new", waiting: false, running: false };
}

function object(): ViewObject {
  return {
    id: "one",
    type: "item",
    link: "operad://objects/item%3Aone",
    row: row("one"),
    sections: [
      { id: "diff", title: "Diff" },
      { id: "plain", title: "Plain" },
    ],
    actions: [],
  };
}

function key(state: TuiState, name: string, shift = false): TuiState {
  return reduce(state, { type: "key", key: name, ...(shift ? { shift: true } : {}) });
}

function typeText(state: TuiState, text: string): TuiState {
  return [...text].reduce((s, char) => reduce(s, { type: "key", key: char, text: char }), state);
}

/** An open object whose first section loaded its first page with a table of contents. */
function opened(withPages = true): TuiState {
  let state = reduce(initialState({ width: 120, height: 24 }), {
    type: "types",
    types: [{ type: "item", title: "Item" }],
  });
  state = reduce(state, { type: "page", tabId: "type:item", replace: true, page: { rows: [row("one")] } });
  state = key(key(state, "3"), "enter");
  state = reduce(state, { type: "object", object: object(), version: 1 });
  const request = state.sectionRequest;
  state = reduce(state, { type: "section-launched" });
  return reduce(state, {
    type: "section",
    objectId: "one",
    sectionId: "diff",
    content: { markdown: "first page", next: "1", ...(withPages ? { pages: TOC } : {}) },
    version: request?.version,
    objectVersion: request?.objectVersion,
  });
}

/** Answers the pending section request with the page it asked for. */
function answer(state: TuiState, markdown: string): TuiState {
  const request = state.sectionRequest;
  expect(request).toBeDefined();
  const next = reduce(state, { type: "section-launched" });
  return reduce(next, {
    type: "section",
    objectId: "one",
    sectionId: "diff",
    content: { markdown, pages: TOC },
    ...(request?.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request?.jump === undefined ? {} : { jump: request.jump }),
    version: request?.version,
    objectVersion: request?.objectVersion,
  });
}

describe("a section with pages", () => {
  test("the position line names the page and its label", () => {
    let state = opened();
    expect(pagePosition(activeSection(state))).toBe("page 1/4 · overview");
    state = answer(key(state, "n"), "manual");
    expect(pagePosition(activeSection(state))).toBe("page 2/4 · docs/manual.md");
  });

  test("p opens the picker, fuzzy matches labels, and Enter loads the page at the top", () => {
    let state = opened();
    state = key(state, "p");
    expect(state.input?.kind).toBe("pages");
    expect(pageEntries(state).map((entry) => entry.label)).toEqual(TOC.map((page) => page.label));
    state = typeText(state, "manual");
    expect(pageEntries(state).map((entry) => entry.label)).toEqual(["docs/manual.md"]);
    state = key(state, "enter");
    expect(state.input).toBeUndefined();
    expect(state.sectionRequest).toMatchObject({ sectionId: "diff", cursor: "1", jump: 1 });
    state = answer(state, "manual page");
    const section = activeSection(state);
    expect(section?.markdown).toBe("manual page");
    expect(section?.scroll).toBe(0);
    expect(pagePosition(section)).toBe("page 2/4 · docs/manual.md");
  });

  test("the picker moves with the arrows, and Escape closes it without loading", () => {
    let state = key(opened(), "p");
    state = key(key(state, "down"), "down");
    state = key(state, "enter");
    expect(state.sectionRequest).toMatchObject({ cursor: "2", jump: 2 });
    state = key(key(opened(), "p"), "escape");
    expect(state.input).toBeUndefined();
    expect(state.sectionRequest).toBeUndefined();
  });

  test("a jump to the first page asks without a cursor", () => {
    let state = answer(key(opened(), "n"), "manual");
    state = key(key(state, "p"), "enter");
    expect(state.sectionRequest?.jump).toBe(0);
    expect(state.sectionRequest?.cursor).toBeUndefined();
    state = answer(state, "first again");
    expect(activeSection(state)?.markdown).toBe("first again");
    expect(pagePosition(activeSection(state))).toBe("page 1/4 · overview");
  });

  test("n and N step through the pages and stop at both ends", () => {
    let state = opened();
    state = key(state, "n", true);
    expect(state.sectionRequest).toBeUndefined();
    expect(state.notice).toBe("first page");
    state = answer(key(state, "n"), "two");
    expect(state.sectionRequest).toBeUndefined();
    expect(pagePosition(activeSection(state))).toBe("page 2/4 · docs/manual.md");
    state = answer(key(state, "n"), "three");
    state = answer(key(state, "n"), "four");
    expect(pagePosition(activeSection(state))).toBe("page 4/4 · README.md");
    const end = key(state, "n");
    expect(end.sectionRequest).toBeUndefined();
    expect(end.notice).toBe("last page");
    state = answer(key(state, "n", true), "three again");
    expect(pagePosition(activeSection(state))).toBe("page 3/4 · src/main.ts");
  });

  test("scrolling into the next page keeps the position on the page that was added", () => {
    let state = opened();
    state = key(state, "end");
    state = answer(state, "second");
    expect(pagePosition(activeSection(state))).toBe("page 2/4 · docs/manual.md");
    state = key(state, "n");
    expect(state.sectionRequest).toMatchObject({ cursor: "2", jump: 2 });
  });

  test("a section without pages ignores p, n and N", () => {
    const plain = opened(false);
    for (const [name, shift] of [["p", false], ["n", false], ["n", true]] as const) {
      const after = key(plain, name, shift);
      expect(after.input).toBeUndefined();
      expect(after.sectionRequest).toBeUndefined();
      expect(after.notice).toBeUndefined();
    }
    expect(pagePosition(activeSection(plain))).toBeUndefined();
  });

  test("the key list names the keys", () => {
    const keys = KEY_LIST.map(([name]) => name);
    expect(keys).toContain("p");
    expect(keys).toContain("n / N");
  });

  test("the picker scrolls so the marked page stays in the box", () => {
    const many = Array.from({ length: 27 }, (_, at) => ({
      label: `file-${at}.ts`,
      ...(at === 0 ? {} : { cursor: String(at) }),
    }));
    let state = opened();
    const request = state.sectionRequest;
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "diff",
      content: { markdown: "first", pages: many },
      version: request?.version,
      objectVersion: request?.objectVersion,
    });
    state = key(state, "p");
    for (let at = 0; at < 20; at += 1) {
      state = key(state, "down");
      const text = drawState(state).overlay?.chunks.map((c) => c.text).join("") ?? "";
      expect(text).toContain(`❯ file-${at + 1}.ts\n`);
    }
  });
});
