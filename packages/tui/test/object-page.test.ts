import { describe, expect, test } from "bun:test";
import type { TextChunk } from "@opentui/core";
import type { ViewObject, ViewRow } from "@operad-io/engine";
import { RESERVED_KEYS, isReserved, resolveBindings } from "../src/actions.ts";
import {
  childProgress,
  displayChildren,
  footerText,
  initialState,
  reduce,
  sectionWidth,
  type TuiChildLayout,
  type TuiState,
} from "../src/state.ts";
import {
  BUILTIN_THEMES,
  chooseChildLayout,
  resolvePalette,
  saveChildLayout,
  saveThemeChoice,
  toRgba,
} from "../src/theme.ts";
import { drawState } from "../src/view/index.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function row(
  id: string,
  state = "todo",
  extra: Partial<ViewRow> = {},
): ViewRow {
  return {
    id,
    title: `Title ${id}`,
    state,
    waiting: false,
    running: false,
    ...extra,
  };
}

const TYPES = [
  { type: "plan", title: "Plan", plugin: "dev" },
  { type: "task", title: "Task", plugin: "dev" },
];

function opened(
  children: readonly ViewRow[],
  width = 120,
  layout: TuiChildLayout = "tree",
  hidden?: number,
  hiddenDone?: number,
  hiddenCancelled?: number,
): TuiState {
  let state = initialState({ width, height: 30, theme: "dark", childLayout: layout });
  state = reduce(state, { type: "types", types: TYPES });
  const plan = row("P-0001-alpha", "confirmed", {
    title: "The alpha plan",
    badge: "P3",
    note: "auto merge · $0.88",
  });
  state = reduce(state, {
    type: "page",
    tabId: "plugin:dev",
    replace: true,
    page: { rows: [plan] },
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  const object: ViewObject = {
    id: "P-0001-alpha",
    type: "plan",
    link: "",
    row: plan,
    sections: [
      { id: "info", title: "Info" },
      { id: "history", title: "History" },
    ],
    actions: [],
  };
  state = reduce(state, { type: "object", object, version: state.objectVersion });
  state = reduce(state, {
    type: "children",
    objectId: "P-0001-alpha",
    version: state.objectVersion,
    entries: children.map((child) => ({ row: child, type: "task" })),
    ...(hidden === undefined ? {} : { hidden }),
    ...(hiddenDone === undefined ? {} : { hiddenDone }),
    ...(hiddenCancelled === undefined ? {} : { hiddenCancelled }),
  });
  return state;
}

function rightText(state: TuiState): string {
  return drawState(state, "dark").right.chunks.map((chunk) => chunk.text).join("");
}

function rightLines(state: TuiState): string[] {
  return rightText(state).split("\n");
}

function pieces(state: TuiState): readonly TextChunk[] {
  return drawState(state, "dark").right.chunks;
}

function colour(chunk: TextChunk): string {
  return (chunk.fg?.toInts() ?? []).join(",");
}

function token(name: keyof typeof BUILTIN_THEMES.dark): string {
  return toRgba(BUILTIN_THEMES.dark[name]).toInts().join(",");
}

function barChunks(state: TuiState): TextChunk[] {
  return pieces(state).filter((chunk) => /^█+$/.test(chunk.text));
}

describe("the object page's child list", () => {
  test("a chain nests under the first sibling with └─ indentation", () => {
    const rows = [
      row("T-0001-a"),
      row("T-0002-b", "todo", { after: ["T-0001-a"] }),
      row("T-0003-c", "todo", { after: ["T-0002-b"] }),
    ];
    const shown = displayChildren(rows, "tree");
    expect(shown.map((entry) => entry.row.id)).toEqual([
      "T-0001-a",
      "T-0002-b",
      "T-0003-c",
    ]);
    expect(shown[0]?.connector).toBe("");
    expect(shown[1]?.connector).toBe("└─");
    expect(shown[2]?.connector).toBe("   └─");
    const text = rightText(opened(rows));
    expect(text).toContain("└─");
    expect(text).toContain("T-0002-b");
  });

  test("a child with two parents hangs under the first and names the other as also after", () => {
    const rows = [
      row("T-0001-a"),
      row("T-0002-b"),
      row("T-0003-c", "todo", { after: ["T-0001-a", "T-0002-b"] }),
    ];
    const shown = displayChildren(rows, "tree");
    expect(shown.map((entry) => entry.row.id)).toEqual([
      "T-0001-a",
      "T-0003-c",
      "T-0002-b",
    ]);
    expect(shown.find((entry) => entry.row.id === "T-0003-c")?.alsoAfter).toEqual([
      "T-0002-b",
    ]);
    expect(rightText(opened(rows))).toContain("also after T-0002-b");
  });

  test("an after id that is not in the list is ignored", () => {
    const rows = [
      row("T-0001-a", "todo", { after: ["T-9999-missing"] }),
      row("T-0002-b"),
    ];
    const shown = displayChildren(rows, "tree");
    expect(shown.map((entry) => entry.row.id)).toEqual(["T-0001-a", "T-0002-b"]);
    expect(shown[0]?.connector).toBe("");
    expect(shown[0]?.alsoAfter).toEqual([]);
    expect(rightText(opened(rows))).not.toContain("T-9999-missing");
  });

  test("a cycle falls back to the list order", () => {
    const rows = [
      row("T-0001-a", "todo", { after: ["T-0002-b"] }),
      row("T-0002-b", "todo", { after: ["T-0001-a"] }),
      row("T-0003-c"),
    ];
    const shown = displayChildren(rows, "tree");
    expect(shown.map((entry) => entry.row.id)).toEqual([
      "T-0001-a",
      "T-0002-b",
      "T-0003-c",
    ]);
    for (const entry of shown) expect(entry.connector).toBe("");
  });

  test("the flat list is one level in list order, with every after as also after", () => {
    const rows = [
      row("T-0001-a"),
      row("T-0002-b", "todo", { after: ["T-0001-a"] }),
      row("T-0003-c", "todo", { after: ["T-0001-a", "T-0002-b"] }),
    ];
    const shown = displayChildren(rows, "list");
    expect(shown.map((entry) => entry.row.id)).toEqual([
      "T-0001-a",
      "T-0002-b",
      "T-0003-c",
    ]);
    for (const entry of shown) expect(entry.connector).toBe("");
    expect(shown[2]?.alsoAfter).toEqual(["T-0001-a", "T-0002-b"]);
  });

  test("a merged child's glyph and state are weak while the bar still fills done", () => {
    const state = opened([
      row("T-0001-open", "running", { mark: "running" }),
      row("T-0002-done", "merged", { mark: "done" }),
    ]);
    const chunks = pieces(state);
    const marker = chunks.find((part) => part.text === "✓ ");
    const merged = chunks.find((part) => part.text.trim() === "merged");
    expect(marker).toBeDefined();
    expect(merged).toBeDefined();
    expect(colour(marker as TextChunk)).toBe(token("weak"));
    expect(colour(merged as TextChunk)).toBe(token("weak"));
    expect(barChunks(state).map(colour)).toEqual([token("ok")]);
  });

  test("a finished child is drawn finished by its mark; a state word alone is not", () => {
    const rows = [
      row("T-1-word", "merged"),
      row("T-2-mark", "settled", { mark: "done" }),
      row("T-3-run", "merged", { mark: "running" }),
    ];
    const progress = childProgress(rows, "tree");
    expect(progress.done).toBe(1);
    const state = opened(rows);
    const lines = rightLines(state);
    const lineOf = (id: string): string => {
      const found = lines.find((line) => line.includes(id));
      if (found === undefined) throw new Error(`no drawn line for ${id}`);
      return found;
    };
    expect(lineOf("T-1-word")).toContain("○");
    expect(lineOf("T-1-word")).not.toContain("✓");
    expect(lineOf("T-2-mark")).toContain("✓");
    // The mark also picks the colour: the state word merged is not dimmed.
    expect(pieces(state).filter((part) => part.text.trim() === "merged").map(colour)).toEqual([
      token("weak"),
      token("run"),
    ]);
  });
});

describe("the object page's frame and columns", () => {
  test("the frame label joins id, state, badge and note with ·, then a blank line and the title", () => {
    const state = opened([row("T-0001-a")]);
    const text = rightText(state);
    expect(text).toContain("╭─ P-0001-alpha · confirmed · P3 · auto merge · $0.88");
    expect(text).toContain("│ \n│ The alpha plan\n");
    expect(text).toContain("╰──");
  });

  test("the page draws at 120 and 200 columns with children, and without them", () => {
    for (const width of [120, 200]) {
      const withChildren = opened([row("T-0001-a"), row("T-0002-b")], width);
      const text = rightText(withChildren);
      expect(text).toContain("P-0001-alpha");
      expect(text).toContain("TASK");
      expect(text).toContain("0 / 2");
      expect(text).toContain("Info · History");
      expect(pieces(withChildren).filter((chunk) => /^█+$/.test(chunk.text))).toEqual([]);
      for (const line of rightLines(withChildren)) {
        expect(line.length).toBeLessThanOrEqual(sectionWidth(withChildren));
      }

      const without = opened([], width);
      const bare = rightText(without);
      expect(bare).toContain("P-0001-alpha");
      expect(bare).toContain("The alpha plan");
      expect(bare).toContain("Info · History");
      expect(bare).not.toContain("█");
      expect(bare).not.toContain("TASK");
      for (const line of rightLines(without)) {
        expect(line.length).toBeLessThanOrEqual(sectionWidth(without));
      }
    }
  });

  test("the title wraps inside the frame", () => {
    let state = opened([row("T-0001-a")]);
    const open = state.object;
    if (open === undefined) throw new Error("no object is open");
    state = {
      ...state,
      object: { ...open, row: { ...open.row, title: "a long title ".repeat(30) } },
    };
    const lines = rightLines(state);
    expect(lines.filter((line) => line.includes("a long title")).length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(sectionWidth(state));
  });

  test("ids of different lengths keep the state and note columns aligned", () => {
    const rows = [
      row("T-1-a", "todo", { note: "first" }),
      row("T-1000-a-much-longer-id", "todo", { note: "second" }),
    ];
    const lines = rightLines(opened(rows));
    const stateAt = lines
      .filter((line) => line.includes("T-1-a") || line.includes("T-1000-a-much-longer-id"))
      .map((line) => line.indexOf("todo"));
    expect(stateAt).toHaveLength(2);
    expect(stateAt[1]).toBe(stateAt[0]);
    expect(stateAt[0] ?? 0).toBeGreaterThan(0);
  });
});

describe("the progress bar and its heading", () => {
  test("the bar fills done children only; cancelled is dark red and comes last", () => {
    const rows = [
      row("T-1-done", "merged", { mark: "done" }),
      row("T-2-run", "running", { mark: "running" }),
      row("T-3-wait", "waiting", { mark: "waiting" }),
      row("T-4-fail", "failed", { mark: "failed" }),
      row("T-5-todo", "new", { mark: "todo" }),
      row("T-6-gone", "cancelled", { mark: "cancelled" }),
    ];
    const state = opened(rows);
    const cells = barChunks(state);
    expect(cells.map(colour)).toEqual([token("ok"), token("cancelled")]);
    expect(token("cancelled")).not.toBe(token("error"));
    expect(token("cancelled")).not.toBe(token("weak"));
  });

  test("cancelled children are counted in neither done nor total, but still draw a cell at the end", () => {
    const rows = [
      row("T-1-done", "merged", { mark: "done" }),
      ...Array.from({ length: 5 }, (_, at) =>
        row(`T-2-gone-${at}`, "cancelled", { mark: "cancelled" })),
      ...Array.from({ length: 6 }, (_, at) => row(`T-3-open-${at}`, "new", { mark: "todo" })),
    ];
    const progress = childProgress(rows, "tree");
    expect(progress.done).toBe(1);
    expect(progress.total).toBe(7);
    expect(progress.entries.map((entry) => entry.row.id)).toEqual([
      "T-1-done",
      ...Array.from({ length: 6 }, (_, at) => `T-3-open-${at}`),
      ...Array.from({ length: 5 }, (_, at) => `T-2-gone-${at}`),
    ]);
    const state = opened(rows);
    const heading = rightLines(state).find((line) => line.includes(" / "));
    expect(heading).toContain("1 / 7");
    expect(heading).not.toContain("merged");
    expect(heading).not.toContain("done");
    const cells = barChunks(state);
    expect(cells.length).toBe(6);
    expect(cells[0]).toBeDefined();
    expect(colour(cells[0] as TextChunk)).toBe(token("ok"));
    expect(cells.slice(1).map(colour)).toEqual(Array.from({ length: 5 }, () => token("cancelled")));
  });

  test("children the filter hid stay out of the heading and the bar", () => {
    const rows = [
      row("T-1-open", "new", { mark: "todo" }),
      row("T-2-run", "running", { mark: "running" }),
      row("T-3-wait", "waiting", { mark: "waiting" }),
    ];
    const progress = childProgress(rows, "tree");
    expect(progress.done).toBe(0);
    expect(progress.total).toBe(3);
    const state = opened(rows, 120, "tree", 3);
    const heading = rightLines(state).find((line) => line.includes(" / "));
    expect(heading).toContain("0 / 3");
    expect(barChunks(state)).toEqual([]);
    expect(state.object?.children?.hidden).toBe(3);
  });

  test("a hidden done or cancelled child draws no cell of its own", () => {
    const rows = [row("T-1-wait", "waiting", { mark: "waiting" })];
    const progress = childProgress(rows, "tree");
    expect(progress.done).toBe(0);
    expect(progress.total).toBe(1);
    const state = opened(rows, 120, "tree", 2, 1, 1);
    const heading = rightLines(state).find((line) => line.includes(" / "));
    expect(heading).toContain("0 / 1");
    expect(barChunks(state)).toEqual([]);
    expect(state.object?.children?.hidden).toBe(2);
    expect(state.object?.children?.hiddenDone).toBe(1);
    expect(state.object?.children?.hiddenCancelled).toBe(1);
  });

  test("a waiting child beside done ones does not fill a progress cell", () => {
    const rows = [
      row("T-1-done", "merged", { mark: "done" }),
      row("T-2-wait", "waiting", { mark: "waiting" }),
    ];
    const state = opened(rows);
    const heading = rightLines(state).find((line) => line.includes(" / "));
    expect(heading).toContain("1 / 2");
    const cells = barChunks(state);
    expect(cells.length).toBe(1);
    expect(colour(cells[0] as TextChunk)).toBe(token("ok"));
  });

  test("with every child shown, the bar fills only the done ones", () => {
    const rows = [
      row("T-1-done", "merged", { mark: "done" }),
      row("T-2-wait", "waiting", { mark: "waiting" }),
      row("T-3-done", "finished", { mark: "done" }),
    ];
    const state = opened(rows);
    const heading = rightLines(state).find((line) => line.includes(" / "));
    expect(heading).toContain("2 / 3");
    const cells = barChunks(state);
    expect(cells.length).toBe(2);
    expect(cells.map(colour)).toEqual([token("ok"), token("ok")]);
  });

  test("the child list puts cancelled rows last", () => {
    const rows = [
      row("T-1-gone", "cancelled", { mark: "cancelled" }),
      row("T-2-open", "new", { mark: "todo" }),
      row("T-3-gone", "cancelled", { mark: "cancelled" }),
      row("T-4-done", "merged", { mark: "done" }),
    ];
    expect(displayChildren(rows, "tree").map((entry) => entry.row.id)).toEqual([
      "T-2-open",
      "T-4-done",
      "T-1-gone",
      "T-3-gone",
    ]);
    expect(displayChildren(rows, "list").map((entry) => entry.row.id)).toEqual([
      "T-2-open",
      "T-4-done",
      "T-1-gone",
      "T-3-gone",
    ]);
  });

  test("an active child of a cancelled parent is drawn top-level before every cancelled row", () => {
    const rows = [
      row("T-1-gone", "cancelled", { mark: "cancelled" }),
      row("T-2-open", "new", { mark: "todo", after: ["T-1-gone"] }),
      row("T-3-root", "new", { mark: "todo" }),
    ];
    const tree = displayChildren(rows, "tree");
    expect(tree.map((entry) => entry.row.id)).toEqual([
      "T-2-open",
      "T-3-root",
      "T-1-gone",
    ]);
    const open = tree.find((entry) => entry.row.id === "T-2-open");
    expect(open?.connector).toBe("");
    expect(open?.depth).toBe(0);
    expect(open?.alsoAfter).toEqual([]);
    expect(displayChildren(rows, "list").map((entry) => entry.row.id)).toEqual([
      "T-2-open",
      "T-3-root",
      "T-1-gone",
    ]);

    const lines = rightLines(opened(rows));
    const lineOf = (id: string): string => {
      const found = lines.find((line) => line.includes(id));
      if (found === undefined) throw new Error(`no drawn line for ${id}`);
      return found;
    };
    const openLine = lineOf("T-2-open");
    const rootLine = lineOf("T-3-root");
    const cancelledLine = lineOf("T-1-gone");
    expect(openLine).not.toContain("└─");
    expect(openLine).not.toContain("├─");
    expect(openLine.indexOf("○")).toBe(rootLine.indexOf("○"));
    expect(lines.indexOf(openLine)).toBeLessThan(lines.indexOf(cancelledLine));
  });
});

describe("the tree and list layouts", () => {
  test("t toggles the child list, is reserved, and the footer names the layout it switches to", () => {
    expect(RESERVED_KEYS).toContain("t");
    expect(isReserved("T")).toBe(true);
    expect(resolveBindings([{ key: "t", action: "dev:merge", source: "user" }]).bindings).toEqual([]);

    let state = opened([row("T-0001-a"), row("T-0002-b", "todo", { after: ["T-0001-a"] })]);
    expect(state.childLayout).toBe("tree");
    expect(footerText(state)).toContain("t list");
    state = reduce(state, { type: "key", key: "t" });
    expect(state.childLayout).toBe("list");
    expect(state.layoutRequest).toBe("list");
    expect(footerText(state)).toContain("t tree");
    expect(rightText(state)).not.toContain("└─");
    state = reduce(state, { type: "layout-launched" });
    expect(state.layoutRequest).toBeUndefined();
    state = reduce(state, { type: "key", key: "t" });
    expect(state.childLayout).toBe("tree");
  });

  test("t does nothing when the page has no child list, and the footer has no toggle", () => {
    const state = opened([]);
    expect(footerText(state)).not.toContain("t list");
    const after = reduce(state, { type: "key", key: "t" });
    expect(after).toBe(state);
  });

  test("the chosen layout is read from tui.json and saved next to the theme", () => {
    const home = mkdtempSync(join(tmpdir(), "operad-object-page-"));
    expect(chooseChildLayout({ home })).toBe("tree");
    saveChildLayout(home, "list");
    expect(chooseChildLayout({ home })).toBe("list");
    saveThemeChoice(home, "dark");
    expect(chooseChildLayout({ home })).toBe("list");
    const file = JSON.parse(readFileSync(join(home, "tui.json"), "utf8"));
    expect(file).toEqual({ theme: "dark", layout: "list" });
    writeFileSync(join(home, "tui.json"), '{"layout":"sideways"}');
    expect(() => chooseChildLayout({ home })).toThrow("tree");
  });
});

describe("the cancelled token", () => {
  test("every built-in and shipped theme has a dark red apart from error and weak", () => {
    for (const name of ["light", "dark", "terminal"] as const) {
      const palette = BUILTIN_THEMES[name];
      expect(palette.cancelled.length).toBeGreaterThan(0);
      expect(palette.cancelled).not.toBe(palette.error);
      expect(palette.cancelled).not.toBe(palette.weak);
    }
    for (const name of ["dracula", "nord", "solarized-dark", "kanagawa-lotus", "github-light"]) {
      const palette = resolvePalette(name, "dark");
      expect(palette.cancelled).not.toBe(palette.error);
      expect(palette.cancelled).not.toBe(palette.weak);
    }
  });
});

describe("the tree's drawn connectors", () => {
  function drawn(rows: readonly ViewRow[]): string[] {
    const lines = rightLines(opened(rows)).map((line) => line.trimEnd());
    const start = lines.findIndex((line) => line.startsWith("│ TASK")) + 1;
    return lines.slice(start, lines.findIndex((line) => line.startsWith("╰")));
  }

  test("a chain hangs each connector under its parent's glyph", () => {
    expect(
      drawn([
        row("T-0060-a"),
        row("T-0061-b", "todo", { after: ["T-0060-a"] }),
        row("T-0062-c", "todo", { after: ["T-0061-b"] }),
      ]),
    ).toEqual([
      "│   ○ T-0060-a       todo",
      "│   └─ ○ T-0061-b    todo",
      "│      └─ ○ T-0062-c todo",
    ]);
  });

  test("a first child with a child draws ├─ and a │ under the root's glyph", () => {
    expect(
      drawn([
        row("T-0001-a"),
        row("T-0002-b", "todo", { after: ["T-0001-a"] }),
        row("T-0003-c", "todo", { after: ["T-0002-b"] }),
        row("T-0004-d", "todo", { after: ["T-0001-a"] }),
      ]),
    ).toEqual([
      "│   ○ T-0001-a       todo",
      "│   ├─ ○ T-0002-b    todo",
      "│   │  └─ ○ T-0003-c todo",
      "│   └─ ○ T-0004-d    todo",
    ]);
  });

  test("two roots have no connector and no padding", () => {
    expect(drawn([row("T-0001-a"), row("T-0002-b")])).toEqual([
      "│   ○ T-0001-a todo",
      "│   ○ T-0002-b todo",
    ]);
  });
});
