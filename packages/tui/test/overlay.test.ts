import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { initialState, reduce, type TuiInput, type TuiState } from "../src/state.ts";
import { createTuiView, overlayBox, paletteFor } from "../src/view/index.ts";
import { toRgba } from "../src/theme.ts";

/** Rows whose text is one letter, so a cell of the list is easy to tell from a cell of an overlay. */
function listState(width: number, height: number, theme: "light" | "dark" = "dark"): TuiState {
  let state = initialState({ width, height, theme });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  state = reduce(state, {
    type: "rows",
    tabId: "type:item",
    rows: Array.from({ length: Math.max(1, height - 6) }, (_, at) => ({
      id: `item:T-${String(at).padStart(4, "0")}-worker-pool-${"x".repeat(60)}`,
      title: "Z".repeat(120),
      state: "open",
      waiting: false,
      running: false,
    })),
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, {
    type: "object",
    object: {
      id: "item:one",
      type: "item",
      link: "x",
      row: { id: "item:one", title: "One", state: "new", waiting: false, running: false },
      sections: [],
      actions: ["a", "b", "c"].map((short) => ({
        plugin: "tuitest", action: short, on: "item", name: `tuitest:${short}`,
        noteRequired: false, confirm: false,
      })),
    },
  });
  return state;
}

const inputs: Record<string, TuiInput> = {
  palette: { kind: "palette", query: "", cursor: 0 },
  note: { kind: "note", action: "tuitest:a", id: "item:one", text: "hi", required: false, confirm: false },
  confirm: { kind: "confirm", action: "tuitest:a", id: "item:one" },
};

async function frameOf(state: TuiState, width: number, height: number, then?: TuiState): Promise<string[]> {
  const setup = await createTestRenderer({ width, height });
  try {
    const view = createTuiView(setup.renderer);
    view.render(state);
    await setup.renderOnce();
    if (then !== undefined) {
      view.render(then);
      await setup.renderOnce();
    }
    const lines = setup.captureCharFrame().split("\n");
    view.destroy();
    return lines;
  } finally {
    await setup.dispose();
  }
}

describe("overlays", () => {
  for (const [name, input] of Object.entries(inputs)) {
    test(`the ${name} fills its box and closing repaints the list`, async () => {
      const base = listState(120, 30);
      const open = { ...base, input };
      const box = overlayBox(open);
      if (box === undefined) throw new Error("no box");
      const closedFrame = await frameOf(base, 120, 30);
      const lines = await frameOf(open, 120, 30);
      const inside = lines
        .slice(box.top + 2, box.top + box.height - 2)
        .map((line) => line.slice(box.left + 2, box.left + box.width - 2));
      expect(inside.length).toBeGreaterThan(0);
      for (const row of inside) {
        expect(row).not.toContain("Z");
        expect(row).not.toContain("worker");
        expect(row).not.toContain("xx");
      }
      // The one-cell margin is blank all around the text.
      expect(lines[box.top + 1]?.slice(box.left + 1, box.left + box.width - 1).trim()).toBe("");
      expect(lines[box.top + box.height - 2]?.slice(box.left + 1, box.left + box.width - 1).trim()).toBe("");
      const closed = await frameOf(open, 120, 30, base);
      expect(closed).toEqual(closedFrame);
    });
  }

  test("the key list fills its box too", async () => {
    const open = { ...listState(120, 30), keys: true };
    const box = overlayBox(open);
    if (box === undefined) throw new Error("no box");
    const lines = await frameOf(open, 120, 30);
    for (const line of lines.slice(box.top + 1, box.top + box.height - 1)) {
      expect(line.slice(box.left + 1, box.left + box.width - 1)).not.toMatch(/Z|worker|xx/);
    }
  });

  for (const [width, height] of [[120, 40], [60, 20]] as const) {
    test(`at ${width}x${height} the palette, help, note and confirmation are centred`, () => {
      const base = listState(width, height);
      const boxes = [
        overlayBox({ ...base, input: inputs.palette }),
        overlayBox({ ...base, keys: true }),
        overlayBox({ ...base, input: inputs.note }),
        overlayBox({ ...base, input: inputs.confirm }),
      ];
      for (const box of boxes) {
        if (box === undefined) throw new Error("no box");
        expect(box.width).toBe(Math.min(80, width - 4));
        expect(Math.abs(box.left - (width - box.left - box.width))).toBeLessThanOrEqual(1);
      }
    });

    test(`at ${width}x${height} the palette input line stays on its row as matches change`, async () => {
      const base = listState(width, height);
      const rows: number[] = [];
      for (const query of ["", "tuitest:a", "zzz"]) {
        const state = { ...base, input: { kind: "palette", query, cursor: 0 } satisfies TuiInput };
        const lines = await frameOf(state, width, height);
        rows.push(lines.findIndex((line) => line.includes(`: ${query}▏`)));
      }
      expect(rows[0]).toBeGreaterThan(0);
      expect(new Set(rows).size).toBe(1);
    });
  }

  test("a resize re-centres the overlay and the width is fixed across matches", () => {
    const wide = { ...listState(120, 40), input: inputs.palette };
    const narrow = { ...listState(60, 20), input: inputs.palette };
    expect(overlayBox(wide)?.left).toBe(20);
    expect(overlayBox(narrow)?.left).toBe(2);
    const fewer = { ...wide, input: { kind: "palette", query: "tuitest:a", cursor: 0 } satisfies TuiInput };
    expect(overlayBox(fewer)?.width).toBe(overlayBox(wide)?.width);
  });

  for (const theme of ["light", "dark", "terminal"] as const) {
    for (const [name, input] of Object.entries(inputs)) {
      test(`under the ${theme} theme the ${name} box is filled with the background token`, async () => {
        const base = listState(120, 30, theme === "light" ? "light" : "dark");
        const open = { ...base, input };
        const box = overlayBox(open);
        if (box === undefined) throw new Error("no box");
        const want = toRgba(paletteFor(open.theme, theme).background).toInts().join(",");
        const setup = await createTestRenderer({ width: 120, height: 30 });
        try {
          const view = createTuiView(setup.renderer, theme);
          view.render(open);
          await setup.renderOnce();
          const frame = setup.captureSpans();
          const seen = new Set<string>();
          for (let row = box.top + 1; row < box.top + box.height - 1; row += 1) {
            let col = 0;
            for (const span of frame.lines[row]?.spans ?? []) {
              for (let at = 0; at < span.width; at += 1, col += 1) {
                if (col > box.left && col < box.left + box.width - 1) seen.add(span.bg.toInts().join(","));
              }
            }
          }
          expect([...seen]).toEqual([want]);
          view.destroy();
        } finally {
          await setup.dispose();
        }
      });
    }
  }
});
