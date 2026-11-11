import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { paletteEntries } from "../src/actions.ts";
import {
  footerText,
  initialState,
  KEY_GROUPS,
  KEY_LIST,
  reduce,
  type TuiState,
} from "../src/state.ts";
import { createTuiView, drawState, overlayBox, paletteFor } from "../src/view/index.ts";
import { toRgba } from "../src/theme.ts";
import { displayWidth } from "../src/wrap.ts";

const ACTIONS = [
  { plugin: "dev", action: "merge", on: "task", name: "dev:merge", noteRequired: false, confirm: true },
  { plugin: "dev", action: "reject", on: "task", name: "dev:reject", noteRequired: true, confirm: false },
  { plugin: "dev", action: "cancel", on: "task", name: "dev:cancel", noteRequired: false, confirm: true },
] as const;

/** A page with an open object, its actions, settings and the palette. */
function paletteState(width: number, height = 50): TuiState {
  let state = initialState({ width, height, theme: "dark" });
  state = reduce(state, { type: "types", types: [{ type: "task", title: "Task" }] });
  state = reduce(state, {
    type: "rows",
    tabId: "plugin:task",
    rows: [{ id: "task:T-0003-foo", title: "Storage interface", state: "waiting", waiting: true, running: false }],
  });
  state = reduce(state, { type: "key", key: "3", text: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, {
    type: "object",
    object: {
      id: "task:T-0003-foo",
      type: "task",
      link: "x",
      row: { id: "task:T-0003-foo", title: "Storage interface", state: "waiting", waiting: true, running: false },
      sections: [],
      actions: [...ACTIONS],
    },
  });
  state = reduce(state, {
    type: "settings",
    settings: [
      {
        name: "demo.limit",
        scope: "global",
        value: 3,
        default: 2,
        description: "How many at once.",
        type: "integer",
        editable: true,
        confirm: false,
      },
      {
        name: "demo.mode",
        scope: "global",
        value: "a",
        default: "a",
        description: "Which way to work.",
        type: "string",
        enum: ["a", "b", "c"],
        editable: true,
        confirm: false,
      },
    ],
  });
  return { ...state, input: { kind: "palette", query: "", cursor: 0 } };
}

function overlayLines(state: TuiState): string[] {
  const text = (drawState(state).overlay?.chunks ?? []).map((part) => part.text).join("");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineFor(lines: readonly string[], name: string): string {
  const found = lines.find((line) => line.slice(2).startsWith(`${name} `));
  if (found === undefined) throw new Error(`no line for ${name}`);
  return found;
}

function colourOf(part: { readonly fg?: unknown }): string {
  const fg = part.fg as { toInts(): number[] } | undefined;
  return fg === undefined ? "" : fg.toInts().join(",");
}

describe("the overlays' spacing", () => {
  for (const width of [80, 160]) {
    test(`the palette at ${width} columns has a blank line under the input, a dim group label and aligned columns`, () => {
      const state = paletteState(width);
      const box = overlayBox(state);
      if (box === undefined) throw new Error("no box");
      const content = box.width - 4;
      const lines = overlayLines(state);

      expect(lines[0]).toBe(": ▏");
      expect(lines[1]).toBe("");
      const groups = ["actions", "tui", "settings"];
      for (const [at, group] of groups.entries()) {
        const found = lines.indexOf(group);
        expect(found).toBeGreaterThan(0);
        if (at > 0) expect(lines[found - 1]).toBe("");
      }

      const entries = paletteEntries(state);
      expect(entries.map((entry) => entry.group)).toEqual([
        "actions", "actions", "actions", "tui", "tui", "tui", "tui", "tui", "tui", "tui", "tui", "settings", "settings",
      ]);
      const drawn = entries.map((entry) => lineFor(lines, entry.name));
      for (const [at, line] of drawn.entries()) {
        // Every entry fills the frame's inner width, so the key sits at the right edge.
        expect(displayWidth(line)).toBe(content);
        expect(line.slice(0, 2)).toBe(at === 0 ? "❯ " : "  ");
        const key = entries[at]?.key;
        if (key !== undefined) expect(line.endsWith(key)).toBe(true);
      }
      const objects = drawn
        .filter((_, at) => entries[at]?.group === "actions")
        .map((line) => line.indexOf("T-0003-foo"));
      expect(new Set(objects).size).toBe(1);
      expect(objects[0]).toBeGreaterThan(0);

      const palette = paletteFor(state.theme, "auto");
      const weak = toRgba(palette.weak).toInts().join(",");
      for (const group of groups) {
        const label = (drawState(state).overlay?.chunks ?? []).find((part) => part.text === `${group}\n`);
        expect(colourOf(label ?? {})).toBe(weak);
      }
    });

    test(`the key list at ${width} columns aligns every key and puts a blank line between groups`, () => {
      const state = { ...paletteState(width), input: undefined, keys: true };
      const box = overlayBox(state);
      if (box === undefined) throw new Error("no box");
      const lines = overlayLines(state);
      const keyWidth = Math.max(...KEY_LIST.map(([key]) => displayWidth(key)));
      const description = 2 + keyWidth + 2;

      expect(lines[0]).toBe("keys");
      const keyLines = lines.filter((line) => line !== "" && line !== "keys");
      expect(keyLines).toHaveLength(KEY_LIST.length);
      for (const line of keyLines) {
        expect(line.slice(2 + keyWidth, description)).toBe("  ");
        expect(line.slice(description).trim()).not.toBe("");
        expect(displayWidth(line)).toBeLessThanOrEqual(box.width - 4);
      }
      for (const group of KEY_GROUPS) {
        const first = group[0]?.[0] ?? "";
        const at = lines.findIndex((line) => line.slice(2).startsWith(`${first}`));
        expect(at).toBeGreaterThan(0);
        if (at > 1) expect(lines[at - 1]).toBe("");
      }
      expect(lines.filter((line) => line === "")).toHaveLength(KEY_GROUPS.length - 1);
    });

    test(`the palette, the key list, a note and a confirmation start one column inside the frame at ${width} columns`, async () => {
      const base = paletteState(width);
      const note: TuiState = {
        ...base,
        input: { kind: "note", action: "dev:merge", id: "task:T-0003-foo", text: "hi", required: false, confirm: false },
      };
      const confirm: TuiState = {
        ...base,
        input: { kind: "confirm", action: "dev:merge", id: "task:T-0003-foo" },
      };
      const states: readonly TuiState[] = [base, { ...base, input: undefined, keys: true }, note, confirm];
      for (const state of states) {
        const box = overlayBox(state);
        if (box === undefined) throw new Error("no box");
        const setup = await createTestRenderer({ width, height: state.height });
        try {
          const view = createTuiView(setup.renderer);
          view.render(state);
          await setup.renderOnce();
          const lines = setup.captureCharFrame().split("\n");
          const first = lines[box.top + 2] ?? "";
          expect(first[box.left]).toBe("│");
          expect(first[box.left + 1]).toBe(" ");
          expect(first.slice(box.left + 2).trim()).not.toBe("");
          const last = lines[box.top + box.height - 2] ?? "";
          expect(last[box.left + box.width - 1]).toBe("│");
          expect(last[box.left + box.width - 2]).toBe(" ");
          view.destroy();
        } finally {
          await setup.dispose();
        }
      }
    });
  }

  test("the footer separates hints with a dot, the keys in the text colour and the hints weak", () => {
    const state = initialState({ width: 160, height: 24, theme: "dark" });
    const drawing = drawState(state);
    const text = drawing.footer.chunks.map((part) => part.text).join("");
    const palette = paletteFor(state.theme, "auto");
    expect(text.trimStart()).toBe(footerText(state));
    expect(text).toContain(" · ");
    expect(text).not.toContain("  ");

    const key = drawing.footer.chunks.find((part) => part.text === "j/k ");
    const hint = drawing.footer.chunks.find((part) => part.text === "move");
    if (key === undefined || hint === undefined) throw new Error("the footer has no move hint");
    expect(colourOf(key)).toBe(toRgba(palette.text).toInts().join(","));
    expect(colourOf(hint)).toBe(toRgba(palette.weak).toInts().join(","));
    const separators = drawing.footer.chunks.filter((part) => part.text === " · ");
    expect(separators.length).toBeGreaterThan(1);
    for (const separator of separators) {
      expect(colourOf(separator)).toBe(toRgba(palette.weak).toInts().join(","));
    }
  });
});
