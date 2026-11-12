import { describe, expect, test } from "bun:test";
import { initialState, listWidth, dividerX, rightX, twoPane, bodyHeight, type TuiState } from "../src/state.ts";
import { BUILTIN_THEMES, toRgba } from "../src/theme.ts";
import { dividerColour, drawState } from "../src/view/index.ts";
import { reduce } from "../src/state.ts";

function stateAt(width: number, theme: "light" | "dark" = "dark"): TuiState {
  let state = initialState({ width, height: 30, theme });
  state = reduce(state, { type: "types", types: [{ type: "task", title: "Task" }] });
  return state;
}

const TAB_IDS = ["pending", "running", "plugin:dev", "plugin:chat"] as const;

function stateOnTab(width: number, tabId: string): TuiState {
  let state = initialState({ width, height: 30 });
  state = reduce(state, {
    type: "types",
    types: [
      { type: "repo", title: "Repository", plugin: "dev" },
      { type: "note", title: "Note", plugin: "chat" },
    ],
  });
  const at = state.tabs.findIndex((tab) => tab.id === tabId);
  if (at < 0) throw new Error(`no tab ${tabId}`);
  return reduce(state, { type: "key", key: String(at + 1) });
}

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = toRgba(hex).toInts();
  const lin = (v: number | undefined): number => {
    const c = (v ?? 0) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The least contrast the divider has against the background (WCAG's 4.5:1 for text). */
const MIN_DIVIDER_CONTRAST = 4.5;

describe("the frame follows the terminal", () => {
  test("the list is 26% of the width between 24 and 38 columns, and the divider follows", () => {
    expect([80, 120, 200].map((w) => listWidth(stateAt(w)))).toEqual([24, 31, 38]);
    expect([80, 120, 200].map((w) => dividerX(stateAt(w)))).toEqual([26, 33, 40]);
    expect([80, 120, 200].map((w) => rightX(stateAt(w)))).toEqual([28, 35, 42]);
  });

  test("every tab puts the divider in the same column at 80, 120 and 200", () => {
    const columns = [80, 120, 200].map((width) =>
      TAB_IDS.map((tabId) => dividerX(stateOnTab(width, tabId))),
    );
    expect(columns.map((at) => new Set(at).size)).toEqual([1, 1, 1]);
    expect(columns.map((at) => at[0])).toEqual([26, 33, 40]);
  });

  test("one pane below the narrower list's threshold, two from it", () => {
    expect(twoPane(stateAt(80))).toBe(false);
    expect(twoPane(stateAt(83))).toBe(false);
    expect(twoPane(stateAt(84))).toBe(true);
    expect(twoPane(stateAt(99))).toBe(true);
    expect(twoPane(stateAt(120))).toBe(true);
    expect(twoPane(stateAt(200))).toBe(true);
  });

  test("the drawn divider is as tall as the body at every width", () => {
    for (const width of [80, 120, 200]) {
      const state = stateAt(width);
      const text = drawState(state).divider.chunks.map((c) => c.text).join("");
      expect(text.split("\n").length).toBe(bodyHeight(state));
    }
  });

  test("the divider contrasts with the background in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const palette = BUILTIN_THEMES[theme];
      const colour = dividerColour(palette);
      expect(contrast(colour, palette.background)).toBeGreaterThanOrEqual(MIN_DIVIDER_CONTRAST);
      // The old rule colour was far too close to the background.
      expect(contrast(palette.rule, palette.background)).toBeLessThan(MIN_DIVIDER_CONTRAST);
      const drawn = drawState(stateAt(120, theme), theme).divider.chunks[0]?.fg;
      expect(drawn?.toInts().join(",")).toBe(toRgba(colour).toInts().join(","));
    }
  });

  test("the list has a blank line, a dim title and, for a type list, its filter", () => {
    const state = reduce(stateAt(120), { type: "key", key: "3", text: "3" });
    const text = drawState(state).list.chunks.map((c) => c.text).join("");
    expect(text.startsWith("\nTASK")).toBe(true);
  });
});
