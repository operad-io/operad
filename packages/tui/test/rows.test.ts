import { describe, expect, test } from "bun:test";
import type { RunningItem } from "@operad-io/engine";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import { BUILTIN_THEMES, toRgba } from "../src/theme.ts";
import { drawState } from "../src/view/index.ts";

interface Colour {
  toInts(): readonly number[];
}
interface Piece {
  readonly text: string;
  readonly bg?: Colour | undefined;
  readonly fg?: Colour | undefined;
}

const sameColour = (colour: Colour | undefined, hex: string): boolean =>
  colour?.toInts().join(",") === toRgba(hex).toInts().join(",");
const TINT = BUILTIN_THEMES.dark.tint;
const WEAK = BUILTIN_THEMES.dark.weak;

/** The list drawn as lines of chunks, split at each newline chunk. */
function drawnLines(state: TuiState): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const piece of drawState(state).list.chunks as readonly Piece[]) {
    if (piece.text === "\n") lines.push([]);
    else lines[lines.length - 1]?.push(piece);
  }
  return lines;
}

const textOf = (line: readonly Piece[] | undefined): string =>
  (line ?? []).map((piece) => piece.text).join("");

const run = (at: number, extra: Partial<RunningItem> = {}): RunningItem => ({
  runId: `run-${at}`,
  flow: "dev",
  step: "work",
  startedAt: 0,
  elapsedMs: 61_000,
  object: `operad/T-009${at}-flaky-survey`,
  title: "Survey the flaky tests",
  stepStartedAt: 0,
  stepElapsedMs: 2_500,
  queued: null,
  stepLabel: "work",
  ...extra,
});

function running(width: number, items: readonly RunningItem[], height = 24): TuiState {
  let state = initialState({ width, height, theme: "dark" });
  state = reduce(state, { type: "running", items });
  return reduce(state, { type: "key", key: "2" });
}

function typeList(width: number, count: number, height = 24): TuiState {
  let state = initialState({ width, height, theme: "dark" });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  state = reduce(state, {
    type: "page",
    tabId: "type:item",
    replace: true,
    page: {
      rows: Array.from({ length: count }, (_, at) => ({
        id: `ops/T-${String(at).padStart(4, "0")}-flaky-survey`,
        title: "Survey the flaky tests",
        state: "running",
        badge: "#2",
        ...(at === 0 ? {} : { note: "work 16m" }),
        waiting: false,
        running: true,
      })),
    },
  });
  return reduce(state, { type: "key", key: "3" });
}

describe("two-line rows", () => {
  test("a type list row: id and slug, title, then the dim state, badge and note", () => {
    const lines = drawnLines(typeList(120, 3));
    // lines[0] is the blank line above the title, lines[1] the title.
    expect(textOf(lines[2]).trimEnd()).toBe("❯ ◐ T-0000 flaky-survey  Survey the flaky tests");
    expect(textOf(lines[4])).toBe("");
    expect(textOf(lines[5]).trimEnd()).toBe("  ◐ T-0001 flaky-survey  Survey the flaky tests");
    expect(textOf(lines[6]).trimEnd()).toBe("    running #2 · work 16m");
    expect(textOf(lines[2])).not.toContain("ops");
  });

  test("a row with no note draws one dim part", () => {
    const lines = drawnLines(typeList(120, 2));
    const dim = lines[3] ?? [];
    expect(textOf(dim).trim()).toBe("running #2");
    expect(textOf(dim)).not.toContain("·");
    expect(dim.filter((piece) => sameColour(piece.fg, WEAK) && piece.text.trim() !== "")).toHaveLength(1);
  });

  test("the Running row: step, step time, run time, repository", () => {
    const lines = drawnLines(running(120, [run(1)]));
    expect(textOf(lines[2]).trimEnd()).toBe("❯ ◐ T-0091 flaky-survey  Survey the flaky tests");
    expect(textOf(lines[3]).trimEnd()).toBe("    work · 2.5s · 1m 1s · operad");
    // Empty parts are left out: no step time, no repository.
    const bare = drawnLines(
      running(120, [run(1, { stepElapsedMs: null, stepStartedAt: null, object: "T-0091-x" })]),
    );
    expect(textOf(bare[3]).trimEnd()).toBe("    work · 1m 1s");
  });

  test("a Running row that names no object shows the flow alone on its first line", () => {
    const lines = drawnLines(running(120, [run(1, { object: null, title: null })]));
    expect(textOf(lines[2]).trimEnd()).toBe("❯ ◐ dev");
    expect(textOf(lines[3]).trimEnd()).toBe("    work · 2.5s · 1m 1s");
  });

  test("a Pending row: the waiting reason, then the repository", () => {
    const pending = (width: number, prompt: string, title: string): TuiState => {
    let state = initialState({ width, height: 24, theme: "dark" });
    state = reduce(state, {
      type: "pending",
      items: [
        {
          runId: "r1",
          flow: "dev",
          step: "merge",
          prompt,
          choices: [],
          actions: [],
          object: "task:operad/T-0093-flaky-survey",
          row: { id: "T-0093-flaky-survey", title, state: "waiting", waiting: true, running: false },
        },
      ],
    });
    return state;
    };
    const lines = drawnLines(pending(120, "Ready to merge", "Survey the flaky tests"));
    expect(textOf(lines[2]).trimEnd()).toBe("❯ ● T-0093 flaky-survey  Survey the flaky tests");
    expect(textOf(lines[3]).trimEnd()).toBe("    Ready to merge · operad");
    // One pane: both lines cut with … at the pane edge, nothing wraps.
    const narrow = drawnLines(pending(60, "Ready to merge ".repeat(8), "A very long title ".repeat(9)));
    expect(textOf(narrow[2]).length).toBeLessThanOrEqual(58);
    expect(textOf(narrow[2])).toContain("…");
    expect(textOf(narrow[3]).length).toBeLessThanOrEqual(58);
    expect(textOf(narrow[3])).toEndWith("…");
    expect(narrow.filter((line) => textOf(line).trim() !== "")).toHaveLength(3);
    const fits = drawnLines(pending(60, "Ready to merge", "Survey"));
    expect(textOf(fits[3]).trimEnd()).toBe("    Ready to merge · operad");
  });

  test("at the one-pane width nothing is wider than the pane, and a long id and title cut with …", () => {
    const width = 60;
    const state = running(width, [
      run(1, { object: `operad/T-0091-${"long-slug-".repeat(8)}`, title: "A very long title ".repeat(9) }),
    ]);
    const lines = drawnLines(state);
    const cells = width - 2;
    expect(textOf(lines[2]).length).toBeLessThanOrEqual(cells);
    expect(textOf(lines[2])).toContain("…");
    expect(textOf(lines[3]).length).toBeLessThanOrEqual(cells);
    // Two lines per object: nothing wraps into a third.
    expect(lines.filter((line) => textOf(line).trim() !== "")).toHaveLength(3);
    const narrow = drawnLines(typeList(width, 2));
    expect(textOf(narrow[2]).trimEnd()).toBe("❯ ◐ T-0000 flaky-survey  Survey the flaky tests");
    expect(textOf(narrow[3]).trimEnd()).toBe("    running #2");
  });

  test("a long dim line is cut with … at the pane edge", () => {
    const lines = drawnLines(
      running(60, [run(1, { stepLabel: `queued (${"key-".repeat(30)}, 3 ahead)` })]),
    );
    expect(textOf(lines[3]).length).toBeLessThanOrEqual(58);
    expect(textOf(lines[3])).toEndWith("…");
  });

  test("the selection tint covers both lines to the pane edge and not the blank line", () => {
    const lines = drawnLines(typeList(120, 3));
    const width = 48;
    for (const at of [2, 3]) {
      expect(textOf(lines[at]).length).toBe(width);
      expect((lines[at] ?? []).every((piece) => sameColour(piece.bg, TINT))).toBe(true);
    }
    expect(textOf(lines[4])).toBe("");
    for (const at of [5, 6]) {
      expect((lines[at] ?? []).some((piece) => sameColour(piece.bg, TINT))).toBe(false);
    }
  });

  test("scrolling keeps the cursor object fully visible and never draws half an object", () => {
    // Height 12: the body has 8 lines, 2 above the first object, so 6 for objects: two.
    let state = typeList(120, 10, 12);
    const shown = (s: TuiState): string[] =>
      drawnLines(s)
        .map((line) => textOf(line))
        .filter((text) => text.includes("T-0"));
    expect(shown(state)).toHaveLength(2);
    for (let step = 0; step < 9; step += 1) {
      state = reduce(state, { type: "key", key: "j" });
      const lines = drawnLines(state);
      const at = lines.findIndex((line) => textOf(line).startsWith("❯"));
      expect(at).toBeGreaterThan(0);
      // The cursor object's dim line follows it.
      expect(textOf(lines[at + 1]).trim()).not.toBe("");
      // Every drawn object has both lines.
      const heads = lines.filter((line) => textOf(line).includes("T-0")).length;
      const dims = lines.filter((line) => textOf(line).includes("running #2")).length;
      expect(dims).toBe(heads);
    }
    expect(shown(state).at(-1)).toContain("T-0009");
    expect(shown(state)[1]).toStartWith("❯");
  });
});
