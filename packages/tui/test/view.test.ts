import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  initialState,
  reduce,
  type TuiState,
} from "../src/state.ts";
import { ROW_MARKS } from "@operad-io/engine";
import { MARK_GLYPHS, TUI_PALETTE, createTuiView, drawState } from "../src/view/index.ts";

function frameState(): TuiState {
  let state = initialState({ width: 120, height: 24, theme: "dark" });
  state = reduce(state, {
    type: "types",
    types: [{ type: "item", title: "Item" }],
  });
  state = reduce(state, {
    type: "pending",
    items: [
      {
        runId: "run-1",
        flow: "flow",
        step: "ask",
        prompt: "Approve?",
        choices: ["yes"],
          actions: [],
        object: "item:one",
      },
    ],
  });
  state = reduce(state, {
    type: "page",
    tabId: "type:item",
    replace: true,
    page: {
      rows: [
        {
          id: "one",
          title: "First",
          state: "new",
          waiting: true,
          running: false,
        },
        {
          id: "two",
          title: "Second",
          state: "open",
          running: true,
          waiting: false,
        },
      ],
    },
  });
  return state;
}

describe("the TUI view", () => {
  test("two panes show the header, a waiting marker and the footer", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 });
    try {
      const view = createTuiView(setup.renderer);
      view.render(frameState());
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("operad   Pending 1   Running 0   Item 2");
      expect(frame).toContain("item:one");
      expect(frame).toContain("select an object");
      expect(frame).toContain("q quit");

      const spans = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.text.includes("●"));
      expect(spans.length).toBeGreaterThan(0);
      const waiting = spans.find(
        (span) => span.fg.toInts().join(",") === "167,147,255,255",
      );
      expect(waiting).toBeDefined();
      expect(TUI_PALETTE.dark.accent).toBe("#a793ff");

      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("below 100 columns the right pane is gone", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    try {
      const view = createTuiView(setup.renderer);
      view.render({ ...frameState(), width: 80 });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("operad   Pending 1   Running 0   Item 2");
      expect(frame).not.toContain("select an object");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("thin lines: the rules, the marker column, one divider and no boxes", async () => {
    const dividerAt = async (width: number): Promise<number[]> => {
      const setup = await createTestRenderer({ width, height: 24 });
      try {
        const view = createTuiView(setup.renderer);
        view.render({
          ...reduce(frameState(), { type: "key", key: "3" }),
          width,
          height: 24,
        });
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        expect(lines[1]?.trim()).toMatch(/^─+$/);
        expect(lines[1]?.startsWith(" ─")).toBe(true);
        expect(lines[22]?.trim()).toMatch(/^─+$/);
        expect(lines[23]?.startsWith(" j/k move")).toBe(true);
        expect(lines[2]?.startsWith(" ❯ ● one")).toBe(true);
        expect(lines[3]?.startsWith("   ◐ two")).toBe(true);
        expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/);
        const at = lines.slice(2, 22).map((line) => line.indexOf("│"));
        view.destroy();
        return at;
      } finally {
        await setup.dispose();
      }
    };
    const at100 = await dividerAt(100);
    const at200 = await dividerAt(200);
    expect(new Set(at100)).toEqual(new Set([36]));
    expect(new Set(at200)).toEqual(new Set([36]));
    // 99 columns: the list only, no divider.
    expect((await dividerAt(99)).every((x) => x === -1)).toBe(true);
  });

  test("the object pane text starts two cells after the divider and a long title never pushes the rule", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    try {
      const view = createTuiView(setup.renderer);
      let state = frameState();
      state = {
        ...state,
        width: 100,
        height: 24,
        object: {
          id: "item:one",
          source: "item:one",
          type: "item",
          link: "x",
          row: {
            id: "item:T-0031-tui-object",
            title: "very long title ".repeat(20),
            state: "running",
            note: "work 16m",
            waiting: false,
            running: true,
          },
          sections: [],
          actions: [],
          active: 0,
          loading: false,
          version: 1,
        },
      };
      view.render(state);
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n");
      expect(lines[2]?.indexOf("T-0031-tui-object")).toBe(39);
      expect(lines[2]).toContain("…");
      for (const line of lines.slice(2, 22)) expect(line.indexOf("│")).toBe(36);
      expect(lines[3]?.slice(39).startsWith("running · work 16m")).toBe(true);
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("the key list is the one boxed overlay", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    try {
      const view = createTuiView(setup.renderer);
      view.render({ ...frameState(), keys: true });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("╭");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("a long list scrolls with the cursor and the status takes the footer", async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    try {
      const view = createTuiView(setup.renderer);
      let state = initialState({ width: 80, height: 10, theme: "dark" });
      state = reduce(state, {
        type: "running",
        items: Array.from({ length: 40 }, (_, at) => ({
          runId: `run-${at}`,
          flow: `flow-${at}`,
          step: "work",
          startedAt: 0,
          elapsedMs: 10,
          object: null,
          title: null,
          stepStartedAt: null,
          stepElapsedMs: null,
          queued: null,
          stepLabel: "work",
        })),
      });
      state = reduce(state, { type: "key", key: "2" });
      state = reduce(state, { type: "key", key: "G" });
      state = reduce(state, { type: "status", message: "the token is wrong" });
      view.render(state);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("flow-39");
      expect(frame).not.toContain("flow-0 ");
      expect(frame).toContain("the token is wrong");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("a row without an object shows its label; a row error shows in the footer", () => {
    let state = initialState({ width: 120, height: 10, theme: "dark" });
    state = reduce(state, {
      type: "running",
      items: [
        { runId: "run-1", flow: "my-flow", step: "w", startedAt: 0, elapsedMs: 1, object: null, title: null, stepStartedAt: null, stepElapsedMs: null, queued: null, stepLabel: "w" },
      ],
    });
    state = reduce(state, { type: "key", key: "2" });
    const drawn = drawState(state);
    expect(drawn.list.chunks.map((c) => c.text).join("")).toContain("my-flow");
    expect(drawn.list.chunks.map((c) => c.text).join("")).not.toContain("run-1");
  });

  test("the selected row's error shows in the footer", () => {
    let state = initialState({ width: 120, height: 10, theme: "dark" });
    state = reduce(state, {
      type: "pending",
      items: [
        {
          runId: "r1",
          flow: "f",
          step: null,
          prompt: "q",
          object: "item:T-1-x",
          row: { title: "t", state: "failed", error: "row is broken" },
        },
      ],
    } as never);
    const text = drawState(state).footer.chunks.map((c) => c.text).join("");
    expect(text).toContain("row is broken");
  });

  test("each mark draws its own single-cell character; waiting beats a mark; running without a mark draws running", async () => {
    const width = 100;
    const chars = ROW_MARKS.map((mark) => MARK_GLYPHS[mark].char);
    expect(new Set(chars).size).toBe(ROW_MARKS.length);
    for (const char of chars) expect(Array.from(char)).toHaveLength(1);

    const rows = [
      ...ROW_MARKS.map((mark, index) => ({
        id: `m${index}`,
        title: mark,
        state: mark,
        mark,
        waiting: false,
        running: false,
      })),
      { id: "w1", title: "w", state: "w", mark: "done" as const, waiting: true, running: false },
      { id: "w2", title: "w", state: "w", mark: "ready_to_merge" as const, waiting: true, running: false },
      { id: "r1", title: "r", state: "r", running: true, waiting: false },
      { id: "r2", title: "r", state: "r", mark: "done" as const, running: true, waiting: false },
    ];
    let state = initialState({ width, height: 40, theme: "dark" });
    state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
    state = reduce(state, { type: "page", tabId: "type:item", replace: true, page: { rows } });
    state = reduce(state, { type: "key", key: "3" });
    const setup = await createTestRenderer({ width, height: 40 });
    try {
      const view = createTuiView(setup.renderer);
      view.render({ ...state, width, height: 40 });
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n").slice(2);
      const glyphOf = (id: string): string | undefined =>
        lines.find((line) => line.includes(` ${id}`))?.slice(3, 4);
      ROW_MARKS.forEach((mark, index) => {
        expect(glyphOf(`m${index}`)).toBe(MARK_GLYPHS[mark].char);
      });
      expect(glyphOf("w1")).toBe(MARK_GLYPHS.waiting.char);
      expect(glyphOf("w2")).toBe(MARK_GLYPHS.ready_to_merge.char);
      expect(glyphOf("r1")).toBe(MARK_GLYPHS.running.char);
      expect(glyphOf("r2")).toBe(MARK_GLYPHS.done.char);
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("an object-backed running row shows the object and its title", () => {
    let state = initialState({ width: 120, height: 10, theme: "dark" });
    state = reduce(state, {
      type: "running",
      items: [
        { runId: "run-1", flow: "dev", step: "w", startedAt: 0, elapsedMs: 1, object: "operad/T-0048-x", title: "Type filters", stepStartedAt: null, stepElapsedMs: null, queued: null, stepLabel: "w" },
      ],
    });
    state = reduce(state, { type: "key", key: "2" });
    const text = drawState(state).list.chunks.map((c) => c.text).join("");
    expect(text).toContain("operad/T-0048-x");
    expect(text).toContain("Type filters");
  });
});
