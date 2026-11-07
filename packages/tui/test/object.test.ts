import { describe, expect, test } from "bun:test";
import type { ViewObject, ViewRow } from "@operad-io/engine";
import {
  activeSection,
  initialState,
  reduce,
  type TuiState,
} from "../src/state.ts";

const TYPES = [{ type: "item", title: "Item" }] as const;

function row(id: string): ViewRow {
  return {
    id,
    title: `Title ${id}`,
    state: "new",
    waiting: false,
    running: false,
  };
}

function opened(rowId = "one"): TuiState {
  let state = reduce(initialState({ width: 120, height: 20 }), {
    type: "types",
    types: TYPES,
  });
  state = reduce(state, {
    type: "page",
    tabId: "type:item",
    replace: true,
    page: { rows: [row(rowId)] },
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  return reduce(state, {
    type: "object",
    object: viewObject(rowId),
    version: 1,
  });
}

function viewObject(id = "one"): ViewObject {
  return {
    id,
    type: "item",
    link: `operad://objects/item%3A${id}`,
    row: row(id),
    sections: [
      { id: "info", title: "Info" },
      { id: "pages", title: "Pages", live: true },
      { id: "history", title: "History" },
    ],
    actions: [],
  };
}

describe("the object pane reducer", () => {
  test("Enter opens the selected row and asks for the object", () => {
    let state = reduce(initialState({ width: 120 }), {
      type: "types",
      types: TYPES,
    });
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: { rows: [row("one"), row("two")], next: "more" },
    });
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, { type: "key", key: "down" });
    state = reduce(state, { type: "key", key: "return" });

    expect(state.object?.id).toBe("two");
    expect(state.object?.row.title).toBe("Title two");
    expect(state.objectRequest).toEqual({ id: "two", version: 1 });

    state = reduce(state, {
      type: "object",
      object: viewObject("two"),
      version: 1,
    });
    expect(state.objectRequest).toBeUndefined();
    expect(state.object?.sections.map((section) => section.id)).toEqual([
      "info",
      "pages",
      "history",
    ]);
    expect(state.sectionRequest).toEqual({
      objectId: "two",
      sectionId: "info",
      full: false,
      version: 0,
    });
  });

  test("] and [ switch the section tabs and load the next one", () => {
    let state = opened();
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "info",
      content: { markdown: "# Info" },
    });
    expect(state.sectionRequest).toBeUndefined();
    expect(activeSection(state)?.id).toBe("info");

    state = reduce(state, { type: "key", key: "]" });
    expect(activeSection(state)?.id).toBe("pages");
    expect(state.sectionRequest).toEqual({
      objectId: "one",
      sectionId: "pages",
      full: false,
      version: 0,
    });

    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "pages",
      content: { markdown: "page one", next: "two" },
    });
    state = reduce(state, { type: "key", key: "left" });
    expect(activeSection(state)?.id).toBe("info");
  });

  test("scrolling at the end asks for the section's next page once", () => {
    let state = opened();
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "info",
      content: { markdown: "Info" },
    });
    state = reduce(state, { type: "key", key: "]" });
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "pages",
      content: { markdown: "page one", next: "two" },
    });
    const section = activeSection(state);
    expect(section?.next).toBe("two");

    state = reduce(state, { type: "key", key: "down" });
    const request = state.sectionRequest;
    expect(request).toEqual({
      objectId: "one",
      sectionId: "pages",
      cursor: "two",
      full: false,
      version: section?.version ?? 0,
    });

    state = reduce(state, { type: "key", key: "down" });
    expect(state.sectionRequest).toEqual(request);

    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "pages",
      content: { markdown: "page two" },
      cursor: "two",
      version: request?.version,
    });
    const loaded = activeSection(state);
    expect(loaded?.markdown).toBe("page one\npage two");
    expect(loaded?.next).toBeUndefined();
    expect(loaded?.loading).toBe(false);
    expect(state.sectionRequest).toBeUndefined();
  });

  test("f loads a capped section with full=true", () => {
    let state = opened();
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "info",
      content: {
        markdown:
          "short\n\n[Truncated. See all of it with `operad show one --section info --full`.]\n",
      },
    });
    expect(activeSection(state)?.capped).toBe(true);

    state = reduce(state, { type: "key", key: "f" });
    const request = state.sectionRequest;
    expect(request).toEqual({
      objectId: "one",
      sectionId: "info",
      full: true,
      version: activeSection(state)?.version ?? 0,
    });

    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "info",
      content: { markdown: "the whole section" },
      full: true,
      version: request?.version,
    });
    expect(activeSection(state)?.markdown).toBe("the whole section");
    expect(activeSection(state)?.full).toBe(true);
    expect(activeSection(state)?.capped).toBe(false);
  });

  test("a live section follows its end, scrolling up stops it and G resumes", () => {
    let state = opened();
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "info",
      content: { markdown: "Info" },
    });
    state = reduce(state, { type: "key", key: "]" });
    state = reduce(state, {
      type: "section",
      objectId: "one",
      sectionId: "pages",
      content: {
        markdown: Array.from({ length: 30 }, (_, at) => `line ${at}`).join("\n"),
      },
    });
    const fitted = activeSection(state);
    expect(fitted?.following).toBe(true);
    expect(fitted?.scroll).toBeGreaterThan(0);

    state = reduce(state, { type: "key", key: "up" });
    const stopped = activeSection(state);
    expect(stopped?.following).toBe(false);
    expect(stopped?.scroll).toBeLessThan(fitted?.scroll ?? 0);

    state = reduce(state, { type: "key", key: "G" });
    const resumed = activeSection(state);
    expect(resumed?.following).toBe(true);
    expect(resumed?.scroll).toBe(fitted?.scroll);
  });

  test("escape closes the object and returns to the list", () => {
    let state = opened();
    expect(state.object).toBeDefined();
    state = reduce(state, { type: "key", key: "escape" });
    expect(state.object).toBeUndefined();
    expect(state.objectRequest).toBeUndefined();
  });
});
