import { describe, expect, test } from "bun:test";
import type { PendingItem, RunningItem, ViewRow } from "@operad-io/engine";
import {
  activeTab,
  footerText,
  formatElapsed,
  headerText,
  initialState,
  listWindow,
  reduce,
  rowMark,
  tabLabel,
  twoPane,
  type TuiRow,
  type TuiState,
} from "../src/state.ts";

const TYPES = [
  { type: "item", title: "Item" },
  { type: "task", title: "Task" },
] as const;

function withTypes(state: TuiState): TuiState {
  return reduce(state, { type: "types", types: TYPES });
}

function row(id: string, flags: Partial<ViewRow> = {}): ViewRow {
  return {
    id,
    title: `Title ${id}`,
    state: "new",
    waiting: false,
    running: false,
    ...flags,
  };
}

const pending: PendingItem = {
  runId: "run-1",
  flow: "flow",
  step: "ask",
  prompt: "Approve?",
  choices: ["yes"],
  actions: [],
  object: "item:one",
};

const running: RunningItem = {
  runId: "run-2",
  flow: "flow",
  step: "work",
  startedAt: 0,
  elapsedMs: 1_500,
  object: null,
  title: null,
  stepStartedAt: null,
  stepElapsedMs: null,
  queued: null,
  stepLabel: "work",
};

describe("the TUI reducer", () => {
  test("adds a tab per type and switches with digits, tab and shift-tab", () => {
    let state = withTypes(initialState({ width: 120 }));
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      "pending",
      "running",
      "type:item",
      "type:task",
    ]);
    expect(headerText(state)).toBe("operad ─ Pending 0 · Running 0 · Item · Task");

    state = reduce(state, { type: "key", key: "3" });
    expect(activeTab(state)?.id).toBe("type:item");
    state = reduce(state, { type: "key", key: "tab" });
    expect(activeTab(state)?.id).toBe("type:task");
    state = reduce(state, { type: "key", key: "tab", shift: true });
    expect(activeTab(state)?.id).toBe("type:item");
    state = reduce(state, { type: "key", key: "9" });
    expect(activeTab(state)?.id).toBe("type:item");

    state = reduce(state, { type: "key", key: "1" });
    expect(activeTab(state)?.id).toBe("pending");
    state = reduce(state, { type: "key", key: "tab", shift: true });
    expect(activeTab(state)?.id).toBe("type:task");
  });

  test("moving past the end asks for the next page once and appends it once", () => {
    let state = withTypes(initialState({ width: 120 }));
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: { rows: [row("one"), row("two")], next: "after-two" },
    });
    expect(activeTab(state)?.list.cursor).toBe(0);
    expect(state.pageRequest).toBeUndefined();

    state = reduce(state, { type: "key", key: "j" });
    expect(activeTab(state)?.list.cursor).toBe(1);
    expect(state.pageRequest).toEqual({
      tabId: "type:item",
      cursor: "after-two",
      version: 1,
    });
    expect(activeTab(state)?.list.loading).toBe(true);

    const asked = state.pageRequest;
    state = reduce(state, { type: "key", key: "j" });
    expect(state.pageRequest).toBe(asked);
    expect(activeTab(state)?.list.loading).toBe(true);

    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      page: { rows: [row("three"), row("four")] },
    });
    expect(activeTab(state)?.list.rows.map((entry) => entry.id)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(activeTab(state)?.list.loading).toBe(false);
    expect(state.pageRequest).toBeUndefined();
    expect(activeTab(state)?.list.cursor).toBe(1);
  });

  test("Down on a one-row page asks for the next page and retries after a failure", () => {
    let state = withTypes(initialState());
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: { rows: [row("one")], next: "more" },
    });
    state = reduce(state, { type: "key", key: "down" });
    expect(state.pageRequest).toEqual({
      tabId: "type:item",
      cursor: "more",
      version: 1,
    });

    state = reduce(state, {
      type: "page-error",
      tabId: "type:item",
      message: "offline",
    });
    expect(state.pageRequest).toBeUndefined();
    state = reduce(state, { type: "key", key: "down" });
    expect(state.pageRequest).toEqual({
      tabId: "type:item",
      cursor: "more",
      version: 1,
    });
  });

  test("resize crosses 100 columns and carries the theme", () => {
    let state = initialState({ width: 120, height: 30, theme: "dark" });
    expect(twoPane(state)).toBe(true);
    state = reduce(state, { type: "resize", width: 99, height: 24 });
    expect(twoPane(state)).toBe(false);
    expect(state.height).toBe(24);
    state = reduce(state, { type: "resize", width: 100, height: 20, theme: "light" });
    expect(twoPane(state)).toBe(true);
    expect(state.theme).toBe("light");
    state = reduce(state, { type: "theme", theme: "dark" });
    expect(state.theme).toBe("dark");
  });

  test("a pending item with a row shows the object's title and state, and the question as the note", () => {
    let state = withTypes(initialState());
    const items: PendingItem[] = [];
    for (let index = 0; index < 30; index += 1) {
      items.push({
        ...pending,
        runId: `run-${index}`,
        object: `item:${index}`,
        row: row(`${index}`, { title: `Title ${index}`, state: "open", waiting: true }),
      });
    }
    items.push({
      ...pending,
      runId: "run-bad",
      object: "item:bad",
      row: row("bad", { state: "error", error: "row failed" }),
    });
    state = reduce(state, { type: "pending", items });

    const rows = state.tabs.find((tab) => tab.id === "pending")?.list.rows ?? [];
    expect(rows).toHaveLength(31);
    expect(rows[0]).toMatchObject({
      id: "item:0",
      title: "Title 0",
      state: "open",
      note: "Approve?",
      waiting: true,
    });
    expect(rows[30]).toMatchObject({ id: "item:bad", state: "error", error: "row failed" });
  });

  test("a pending item without a row (an older server) shows its question and flow", () => {
    let state = withTypes(initialState());
    state = reduce(state, { type: "pending", items: [pending] });
    expect(state.tabs.find((tab) => tab.id === "pending")?.list.rows[0]).toMatchObject({
      title: "Approve?",
      state: "flow",
      note: "ask",
    });
  });

  test("each list maps its own flags to a row mark", () => {
    let state = withTypes(initialState());
    state = reduce(state, { type: "pending", items: [pending] });
    state = reduce(state, { type: "running", items: [running] });
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: {
        rows: [
          row("waiting", { waiting: true }),
          row("working", { running: true }),
          row("plain"),
          row("broken", { error: "row failed" }),
        ],
      },
    });

    const pendingRow = state.tabs.find((tab) => tab.id === "pending")?.list.rows[0];
    expect(pendingRow).toMatchObject({
      id: "item:one",
      title: "Approve?",
      waiting: true,
      running: false,
    });
    expect(pendingRow === undefined ? undefined : rowMark(pendingRow)).toBe("waiting");
    const pendingTab = state.tabs.find((tab) => tab.id === "pending");
    expect(pendingTab === undefined ? "" : tabLabel(pendingTab)).toBe("Pending 1");

    const runningRow = state.tabs.find((tab) => tab.id === "running")?.list.rows[0];
    expect(runningRow).toMatchObject({
      id: "run-2",
      title: "flow",
      state: "work",
      note: "1.5s",
      running: true,
    });

    state = reduce(state, {
      type: "running",
      items: [{ ...running, object: "dev/T-1", title: "A title", stepElapsedMs: 2_500 }],
    });
    expect(state.tabs.find((tab) => tab.id === "running")?.list.rows[0]).toMatchObject({
      id: "dev/T-1",
      title: "dev/T-1  A title",
      note: "2.5s",
    });
    expect(runningRow === undefined ? undefined : rowMark(runningRow)).toBe("running");

    const item = state.tabs.find((tab) => tab.id === "type:item")?.list.rows ?? [];
    expect(item.map(rowMark)).toEqual([
      "waiting",
      "running",
      "none",
      "none",
    ]);
    expect(item[3]?.error).toBe("row failed");
    expect(headerText(state)).toContain("Pending 1 · Running 1 · Item · Task");
  });

  test("g and G jump, r asks for a refresh, q quits and ? toggles the key list", () => {
    let state = withTypes(initialState());
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: { rows: [row("one"), row("two"), row("three")], next: "more" },
    });

    state = reduce(state, { type: "key", key: "G", shift: true });
    expect(activeTab(state)?.list.cursor).toBe(2);
    state = reduce(state, { type: "key", key: "g" });
    expect(activeTab(state)?.list.cursor).toBe(0);

    state = reduce(state, { type: "key", key: "r" });
    expect(state.refreshRequested).toBe(true);
    state = reduce(state, { type: "refreshed" });
    expect(state.refreshRequested).toBe(false);

    state = reduce(state, { type: "key", key: "?" });
    expect(state.keys).toBe(true);
    expect(footerText(state)).toContain("? closes");
    state = reduce(state, { type: "key", key: "?" });
    expect(state.keys).toBe(false);

    state = reduce(state, { type: "key", key: "q" });
    expect(state.quit).toBe(true);
  });

  test("a failed next page keeps the rows and reports on the tab", () => {
    let state = withTypes(initialState());
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: { rows: [row("one"), row("two")], next: "two" },
    });
    state = reduce(state, { type: "key", key: "down" });
    expect(state.pageRequest).toBeDefined();
    state = reduce(state, {
      type: "page-error",
      tabId: "type:item",
      message: "the server went away",
    });
    expect(activeTab(state)?.list.error).toBe("the server went away");
    expect(activeTab(state)?.list.loading).toBe(false);
    expect(activeTab(state)?.list.rows).toHaveLength(2);
    expect(state.pageRequest).toBeUndefined();
  });

  test("formatElapsed writes milliseconds, seconds and minutes", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(1_500)).toBe("1.5s");
    expect(formatElapsed(61_000)).toBe("1m 1s");
  });

  test("the window around the cursor counts one line per row, an error row too", () => {
    const rows = Array.from({ length: 30 }, (_, at) => ({
      id: `r${at}`,
      title: "t",
      state: "new",
      waiting: false,
      running: false,
      ...(at === 11 ? { error: "boom" } : {}),
    }));
    const list = { rows, cursor: 12, loaded: true, loading: false, version: 1 };
    const window = listWindow(list, 6);
    expect(window.end - window.start).toBe(6);
    expect(window.start).toBeLessThanOrEqual(12);
    expect(window.end).toBeGreaterThan(12);
    // The line after the rows is kept free.
    const loading = listWindow({ ...list, loading: true }, 6);
    expect(loading.end - loading.start).toBe(5);
    expect(listWindow({ ...list, cursor: 0 }, 6).start).toBe(0);
    // The last row at the bottom of the window stays visible.
    const last = listWindow({ ...list, cursor: 29 }, 6);
    expect(last).toEqual({ start: 24, end: 30 });
    const middle = listWindow({ ...list, cursor: 20 }, 6);
    expect(middle.start).toBeLessThanOrEqual(20);
    expect(middle.end).toBeGreaterThan(20);
  });

  test("ctrl and meta chords are ignored, and only ?, escape and q act while the keys are open", () => {
    let state = withTypes(initialState());
    state = reduce(state, { type: "key", key: "q", ctrl: true });
    state = reduce(state, { type: "key", key: "r", meta: true });
    expect(state.quit).toBe(false);
    expect(state.refreshRequested).toBe(false);

    state = reduce(state, { type: "key", key: "?" });
    expect(state.keys).toBe(true);
    state = reduce(state, { type: "key", key: "r" });
    state = reduce(state, { type: "key", key: "2" });
    expect(state.refreshRequested).toBe(false);
    expect(state.active).toBe(0);
    state = reduce(state, { type: "key", key: "escape" });
    expect(state.keys).toBe(false);
  });
});

describe("rework 1 states", () => {
  test("r does not retry after the token was rotated", () => {
    let state = withTypes(initialState({ width: 80, height: 24, url: "http://x" }));
    state = reduce(state, { type: "connection", connection: "unauthorized" });
    state = reduce(state, { type: "key", key: "r" });
    expect(state.refreshRequested).toBe(false);
  });

  test("a row whose object is gone leaves its list", () => {
    let state = withTypes(initialState({ width: 80, height: 24, url: "http://x" }));
    state = reduce(state, {
      type: "page",
      tabId: "type:item",
      replace: true,
      page: { rows: [row("one"), row("two")] },
    });
    state = reduce(state, { type: "row-gone", id: "one" });
    const ids = state.tabs.find((t) => t.id === "type:item")?.list.rows.map((r) => r.id);
    expect(ids).toEqual(["two"]);
  });

  test("rowMark: waiting keeps only the waiting-side marks, a mark beats running", () => {
    const row = (patch: Partial<TuiRow>): TuiRow => ({
      id: "x",
      title: "x",
      state: "x",
      waiting: false,
      running: false,
      ...patch,
    });
    expect(rowMark(row({ waiting: true, mark: "done" }))).toBe("waiting");
    expect(rowMark(row({ waiting: true, mark: "running" }))).toBe("waiting");
    for (const mark of ["waiting", "proposed", "rework_pending", "ready_to_merge"] as const) {
      expect(rowMark(row({ waiting: true, mark }))).toBe(mark);
    }
    expect(rowMark(row({ mark: "blocked" }))).toBe("blocked");
    expect(rowMark(row({ running: true, mark: "checking" }))).toBe("checking");
    expect(rowMark(row({ running: true }))).toBe("running");
    expect(rowMark(row({}))).toBe("none");
  });
});
