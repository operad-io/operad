import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ViewObject, ViewRow } from "@operad-io/engine";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import { createTuiView } from "../src/view/index.ts";

function row(): ViewRow {
  return {
    id: "one",
    title: "First",
    state: "open",
    note: "$1",
    waiting: true,
    running: false,
  };
}

function object(): ViewObject {
  return {
    id: "one",
    type: "item",
    link: "operad://objects/item%3Aone",
    row: row(),
    sections: [
      { id: "info", title: "Info" },
      { id: "log", title: "Log", live: true },
      { id: "history", title: "History" },
    ],
    actions: [],
  };
}

function opened(): TuiState {
  let state = reduce(initialState({ width: 120, height: 20 }), {
    type: "types",
    types: [{ type: "item", title: "Item" }],
  });
  state = reduce(state, {
    type: "page",
    tabId: "type:item",
    replace: true,
    page: { rows: [row()] },
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, { type: "object", object: object(), version: 1 });
  state = reduce(state, {
    type: "section",
    objectId: "one",
    sectionId: "info",
    content: { markdown: "# Info" },
  });
  return state;
}

describe("the object pane view", () => {
  test("the row, the section tabs and a live dot are in the right pane", async () => {
    const setup = await createTestRenderer({ width: 120, height: 20 });
    try {
      const view = createTuiView(setup.renderer);
      view.render(opened());
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("one");
      expect(frame).toContain("First");
      expect(frame).toContain("open · $1");
      expect(frame).toContain("[Info]");
      expect(frame).toContain("Log ●");
      expect(frame).toContain("History");
      expect(frame).not.toContain("select an object");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("a narrow screen gives the open object the whole body", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    try {
      const view = createTuiView(setup.renderer);
      view.render({ ...opened(), width: 80 });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("First");
      expect(frame).toContain("[Info]");
      expect(frame).toContain("History");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("a live section says following at its end and not after scrolling up", async () => {
    const setup = await createTestRenderer({ width: 120, height: 20 });
    try {
      const view = createTuiView(setup.renderer);
      let state = opened();
      state = reduce(state, { type: "key", key: "]" });
      state = reduce(state, {
        type: "section",
        objectId: "one",
        sectionId: "log",
        content: {
          markdown: Array.from({ length: 30 }, (_, at) => `line ${at}`).join("\n"),
        },
      });
      view.render(state);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("following");

      state = reduce(state, { type: "key", key: "up" });
      view.render(state);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("following");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });
});
