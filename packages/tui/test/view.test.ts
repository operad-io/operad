import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  initialState,
  reduce,
  type TuiState,
} from "../src/state.ts";
import { TUI_PALETTE, createTuiView } from "../src/view/index.ts";

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
      expect(frame).toContain("operad ─ Pending 1 · Running 0 · Item");
      expect(frame).toContain("item:one");
      expect(frame).toContain("Approve?");
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
      expect(frame).toContain("operad ─ Pending 1 · Running 0 · Item");
      expect(frame).not.toContain("select an object");
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
          flow: "flow",
          step: "work",
          startedAt: 0,
          elapsedMs: 10,
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
      expect(frame).toContain("run-39");
      expect(frame).not.toContain("run-0 ");
      expect(frame).toContain("the token is wrong");
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });
});
