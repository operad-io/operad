import { describe, expect, test } from "bun:test";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import { TUI_PALETTE, drawState } from "../src/view/index.ts";

function withItems(width: number, title: string): TuiState {
  let state = initialState({ width, height: 24, theme: "dark" });
  state = reduce(state, { type: "types", types: [{ type: "item", title }] });
  state = reduce(state, {
    type: "page",
    tabId: "plugin:item",
    replace: true,
    page: {
      rows: [{ id: "one", title: "First", state: "new", waiting: false, running: false }],
    },
  });
  return reduce(state, { type: "key", key: "3" } as never);
}

describe("spacing follow-ups", () => {
  test("the tabs are separated by a weak bar, not the filter's dot", () => {
    const header = drawState(withItems(120, "Item")).header.chunks;
    const bars = header.filter((c) => c.text === " │ ");
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.fg).toBeDefined();
    expect(header.map((c) => c.text).join("")).not.toContain(" · ");
    expect(TUI_PALETTE.dark.weak).toBeDefined();
  });

  test("a long list title is cut to the list width", () => {
    const state = withItems(100, "A very long type title ".repeat(6));
    const title = drawState(state).list.chunks.map((c) => c.text).join("").split("\n")[1] ?? "";
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title).toContain("…");
  });

  test("an empty list closes the object beside it, even while a follow waits", () => {
    let state = withItems(120, "Item");
    state = reduce(state, { type: "key", key: "enter" } as never);
    state = { ...state, followPending: true };
    state = reduce(state, {
      type: "page",
      tabId: "plugin:item",
      replace: true,
      page: { rows: [] },
    });
    expect(state.object).toBeUndefined();
    expect(state.followPending).toBe(false);
  });

  test("a refresh does not restart a follow that is already waiting", () => {
    let state = withItems(120, "Item");
    state = reduce(state, { type: "key", key: "j" } as never);
    const before = state.moveSeq;
    state = reduce(state, {
      type: "page",
      tabId: "plugin:item",
      replace: true,
      page: { rows: [{ id: "two", title: "Two", state: "new", waiting: false, running: false }] },
    });
    expect(state.moveSeq).toBe(before);
  });
});
