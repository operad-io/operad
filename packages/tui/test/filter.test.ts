import { describe, expect, test } from "bun:test";
import type { PendingItem, RunningItem, ViewListPage, ViewRow } from "@operad-io/engine";
import {
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import {
  footerText,
  initialState,
  KEY_LIST,
  reduce,
  type TuiStateEvent,
} from "../src/state.ts";
import { drawState } from "../src/view/index.ts";
import { immediateClock } from "./support.ts";

const FILTERS = [
  { name: "active", states: ["proposed", "running"] },
  { name: "all" },
  { name: "done", states: ["merged"] },
  { name: "cancelled", states: ["cancelled"] },
];
const TASK = { type: "task", title: "Task", filters: FILTERS, defaultFilter: "active" };
const PLAIN = { type: "note", title: "Note" };

function row(id: string, state = "proposed"): ViewRow {
  return { id, title: `T ${id}`, state, waiting: false, running: false };
}

function start(width = 120, types: readonly (typeof TASK | typeof PLAIN)[] = [TASK, PLAIN]): TuiState {
  return reduce(initialState({ width, height: 24 }), { type: "types", types });
}

function load(state: TuiState, rows: ViewRow[], hidden?: number, filter?: string): TuiState {
  return reduce(state, {
    type: "page",
    tabId: "type:task",
    replace: true,
    page: { rows, ...(hidden === undefined ? {} : { hidden }) },
    ...(filter === undefined ? {} : { filter }),
  });
}

const key = (state: TuiState, name: string, shift = false): TuiState =>
  reduce(state, { type: "key", key: name, ...(shift ? { shift } : {}) });
const task = (state: TuiState) => state.tabs.find((t) => t.id === "type:task");
const ids = (state: TuiState) => task(state)?.list.rows.map((r) => r.id) ?? [];

/** The task tab active, three rows loaded under `active`, 4 hidden. */
function onTasks(width = 120): TuiState {
  let state = start(width);
  state = key(state, "3");
  return load(state, [row("a"), row("b"), row("c")], 4, "active");
}

const plain = (text: { readonly chunks: readonly { readonly text: string }[] }): string =>
  text.chunks.map((c) => c.text).join("");
const headerOf = (state: TuiState): string => plain(drawState(state).header);
const listOf = (state: TuiState): string => plain(drawState(state).list);

describe("filters: state", () => {
  test("a tab opens on the default filter, a type without filters has none", () => {
    const state = start();
    expect(task(state)?.filter).toBe("active");
    expect(state.tabs.find((t) => t.id === "type:note")?.filter).toBeUndefined();
  });

  test("with no default marked the first filter is used", () => {
    const state = start(120, [{ ...TASK, defaultFilter: undefined }]);
    expect(task(state)?.filter).toBe("active");
  });

  test("f cycles in the server's order and wraps, asking for the first page", () => {
    let state = onTasks();
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = key(state, "f");
      seen.push(task(state)?.filter ?? "");
      expect(state.filterRequest).toEqual({
        tabId: "type:task",
        filter: task(state)?.filter ?? "",
        seq: i + 1,
      });
      state = reduce(state, { type: "filter-launched" });
      expect(state.filterRequest).toBeUndefined();
    }
    expect(seen).toEqual(["all", "done", "cancelled", "active"]);
  });

  test("f does nothing on Pending, Running and a type without filters", () => {
    let state = start();
    for (const tab of ["1", "2", "4"]) {
      const there = key(state, tab);
      const after = key(there, "f");
      expect(after).toBe(there);
      expect(after.filterRequest).toBeUndefined();
    }
    state = key(state, "4");
    expect(state.tabs[state.active]?.filter).toBeUndefined();
  });

  test("the selection stays on the object the new filter still shows", () => {
    let state = onTasks();
    state = key(state, "j");
    state = key(state, "f");
    const moves = state.moveSeq;
    state = load(state, [row("x"), row("a"), row("b"), row("c")], undefined, "all");
    expect(task(state)?.list.cursor).toBe(2);
    expect(state.moveSeq).toBe(moves);
  });

  test("a selection the new filter hides moves to the first row and the pane follows", () => {
    let state = onTasks();
    state = key(state, "j");
    state = key(state, "f");
    const moves = state.moveSeq;
    state = load(state, [row("m", "merged"), row("n", "merged")], undefined, "all");
    expect(task(state)?.list.cursor).toBe(0);
    expect(state.moveSeq).toBe(moves + 1);
    expect(state.followPending).toBe(true);
  });

  test("an empty list under the new filter closes the object pane", () => {
    let state = onTasks();
    state = key(state, "enter");
    expect(state.object).toBeDefined();
    state = key(state, "f");
    state = load(state, [], 0, "all");
    expect(state.object).toBeUndefined();
  });

  test("a page of an older filter is dropped, whatever order the answers come in", () => {
    let state = onTasks();
    state = key(state, "f"); // all
    state = key(state, "f"); // done
    state = load(state, [row("done1", "merged")], 5, "done");
    state = load(state, [row("a"), row("b"), row("z", "merged")], undefined, "all");
    expect(ids(state)).toEqual(["done1"]);
    expect(task(state)?.hidden).toBe(5);
    // an appended page of the old filter is dropped too
    state = reduce(state, {
      type: "page",
      tabId: "type:task",
      page: { rows: [row("old")] },
      filter: "all",
    });
    expect(ids(state)).toEqual(["done1"]);
  });

  test("a page for the old list version is dropped after a cycle", () => {
    let state = onTasks();
    const version = task(state)?.list.version;
    state = key(state, "f");
    state = reduce(state, {
      type: "page",
      tabId: "type:task",
      page: { rows: [row("late")] },
      version,
    });
    expect(ids(state)).toEqual(["a", "b", "c"]);
  });

  test("a live event that takes the selected object out of the filter moves to the next row", () => {
    let state = onTasks();
    state = key(state, "j"); // b
    const moves = state.moveSeq;
    state = reduce(state, { type: "row", row: row("b", "merged") });
    expect(ids(state)).toEqual(["a", "c"]);
    expect(task(state)?.list.cursor).toBe(1);
    expect(task(state)?.list.rows[1]?.id).toBe("c");
    expect(task(state)?.hidden).toBe(5);
    expect(state.moveSeq).toBe(moves + 1);
  });

  test("a live event that leaves the last row selects the new last row", () => {
    let state = onTasks();
    state = key(state, "G");
    state = reduce(state, { type: "row", row: row("c", "cancelled") });
    expect(ids(state)).toEqual(["a", "b"]);
    expect(task(state)?.list.cursor).toBe(1);
  });

  test("a live event that keeps the object in the filter replaces its row in place", () => {
    let state = onTasks();
    state = reduce(state, { type: "row", row: row("b", "running") });
    expect(task(state)?.list.rows.map((r) => r.state)).toEqual(["proposed", "running", "proposed"]);
    expect(task(state)?.hidden).toBe(4);
  });

  test("an error row and the `all` filter never leave the list", () => {
    let state = onTasks();
    state = reduce(state, { type: "row", row: row("b", "error") });
    expect(ids(state)).toEqual(["a", "b", "c"]);
    state = key(state, "f");
    state = load(state, [row("a"), row("b")], undefined, "all");
    state = reduce(state, { type: "row", row: row("b", "merged") });
    expect(ids(state)).toEqual(["a", "b"]);
  });

  test("a refresh keeps the chosen filter while the type still declares it", () => {
    let state = onTasks();
    state = key(state, "f");
    state = reduce(state, { type: "types", types: [TASK, PLAIN] });
    expect(task(state)?.filter).toBe("all");
    state = reduce(state, {
      type: "types",
      types: [{ ...TASK, filters: [{ name: "open", states: ["x"] }], defaultFilter: "open" }, PLAIN],
    });
    expect(task(state)?.filter).toBe("open");
  });

  test("f with an object open cycles the filter in two panes and does nothing on a narrow screen", () => {
    let state = onTasks();
    const event: TuiStateEvent = { type: "key", key: "enter" };
    state = reduce(state, event);
    expect(state.object).toBeDefined();
    // the section is not capped, so f cycles the filter in two panes
    expect(task(key(state, "f"))?.filter).toBe("all");
    // on a narrow screen the list is hidden: f does not cycle
    const narrow = reduce(state, { type: "resize", width: 80, height: 24 });
    expect(task(key(narrow, "f"))?.filter).toBe("active");
  });
});

describe("filters: view", () => {
  test("the header shows the filter and what it hides, in the weak colour", () => {
    const state = onTasks();
    expect(headerOf(state)).toContain("Task 3 · active · 4 hidden");
  });

  test("no hidden count when nothing is hidden or the filter is all", () => {
    let state = load(onTasks(), [row("a")], 0, "active");
    expect(headerOf(state)).toContain("Task 1 · active");
    expect(headerOf(state)).not.toContain("hidden");
    state = key(state, "f");
    state = load(state, [row("a")], 9, "all");
    expect(headerOf(state)).toContain("Task 1 · all");
    expect(headerOf(state)).not.toContain("hidden");
  });

  test("the filter shows only on the current tab; a type without filters has no suffix", () => {
    let state = onTasks();
    expect(headerOf(state).match(/ · /g)?.length).toBe(2);
    state = key(state, "4");
    expect(headerOf(state)).not.toContain(" · ");
    state = key(state, "1");
    expect(headerOf(state)).not.toContain(" · ");
  });

  test("a 99-column terminal shows the same header, cut with … when it does not fit", () => {
    const wide = headerOf(onTasks(120));
    expect(headerOf(onTasks(99))).toBe(wide);
    const tight = headerOf(onTasks(30));
    expect(tight.length).toBeLessThanOrEqual(30);
    expect(tight.endsWith("…")).toBe(true);
  });

  test("an empty filtered list shows one weak line naming the filter", () => {
    let state = onTasks();
    state = key(state, "f");
    state = key(state, "f");
    state = key(state, "f");
    state = load(state, [], 6, "cancelled");
    expect(listOf(state)).toBe("no cancelled tasks");
    state = key(state, "f");
    state = load(state, [], undefined, "active");
    expect(listOf(state)).toBe("no active tasks");
  });

  test("an empty all filter reads no all tasks", () => {
    let state = key(onTasks(), "f");
    state = load(state, [], undefined, "all");
    expect(listOf(state)).toBe("no all tasks");
  });

  test("an old answer for a filter cycled back to is dropped", () => {
    let state = onTasks();
    const asked: (number | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = key(state, "f");
      asked.push(state.filterRequest?.seq);
      state = reduce(state, { type: "filter-launched" });
    }
    expect(task(state)?.filter).toBe("active");
    const page = (id: string, filterSeq: number | undefined): TuiStateEvent => ({
      type: "page",
      tabId: "type:task",
      replace: true,
      page: { rows: [row(id)] },
      filter: "active",
      filterSeq,
    });
    state = reduce(state, page("new", asked[3]));
    state = reduce(state, page("old", 0));
    expect(ids(state)).toEqual(["new"]);
  });

  test("the footer offers f filter only on a tab that has filters", () => {
    const on = onTasks();
    expect(footerText(on)).toContain("f filter");
    expect(footerText(key(on, "1"))).not.toContain("f filter");
    expect(footerText(key(on, "2"))).not.toContain("f filter");
    expect(footerText(key(on, "4"))).not.toContain("f filter");
  });

  test("the footer keeps f full with a narrow object open, and the key list names f", () => {
    const narrow = reduce(key(onTasks(), "enter"), { type: "resize", width: 80, height: 24 });
    expect(footerText(narrow)).toContain("f full");
    expect(footerText(narrow)).not.toContain("f filter");
    expect(KEY_LIST.some(([k, what]) => k === "f" && what.includes("filter"))).toBe(true);
  });
});

class Client implements TuiShellClient {
  readonly filters: (string | undefined)[] = [];
  readonly answers = new Map<string, (page: ViewListPage) => void>();
  types() {
    return Promise.resolve({ types: [TASK] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  private readonly waiters: (() => void)[] = [];
  /** Resolves once a fetch for `filter` is waiting for its answer. */
  asked(filter: string): Promise<void> {
    if (this.answers.has(filter)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  objects(_t: string, _c?: string, _s?: AbortSignal, filter?: string): Promise<ViewListPage> {
    this.filters.push(filter);
    queueMicrotask(() => {
      for (const w of this.waiters.splice(0)) w();
    });
    if (filter === "active" || filter === undefined) {
      return Promise.resolve({ rows: [row("a")], hidden: 1 });
    }
    return new Promise((resolve) => this.answers.set(filter, resolve));
  }
}

class NoEvents implements TuiEventSource {
  stop(): void {}
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return { next: () => new Promise(() => undefined) };
  }
}

function harness(client: Client) {
  let last: TuiState | undefined;
  const waiters: { test: (s: TuiState) => boolean; resolve: () => void }[] = [];
  const view: TuiView = {
    render(state) {
      last = state;
      for (const w of waiters.splice(0)) {
        if (w.test(state)) w.resolve();
        else waiters.push(w);
      }
    },
    destroy() {},
  };
  const shell = startShell({
    client,
    events: () => new NoEvents(),
    view,
    width: 120,
    height: 24,
    theme: "dark",
    clock: immediateClock,
  });
  return {
    shell,
    state: (): TuiState => last ?? initialState(),
    until: (test: (s: TuiState) => boolean): Promise<void> =>
      last !== undefined && test(last)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ test, resolve })),
  };
}

describe("filters: shell", () => {
  test("the first fetch uses the default filter, and a refresh the chosen one", async () => {
    const client = new Client();
    const h = harness(client);
    await h.until((s) => task(s)?.list.loaded === true);
    expect(client.filters).toEqual(["active"]);
    h.shell.key({ name: "3" });
    h.shell.key({ name: "f" });
    await client.asked("all");
    client.answers.get("all")?.({ rows: [row("a"), row("m", "merged")] });
    await h.until((s) => ids(s).length === 2);
    client.answers.clear();
    h.shell.key({ name: "r" });
    await client.asked("all");
    expect(client.filters.at(-1)).toBe("all");
    h.shell.stop();
  });

  test("cycling quickly while fetches are in flight shows the last filter's rows", async () => {
    const client = new Client();
    const h = harness(client);
    await h.until((s) => task(s)?.list.loaded === true);
    expect(task(h.state())?.hidden).toBe(1);
    h.shell.key({ name: "3" });
    h.shell.key({ name: "f" }); // all
    h.shell.key({ name: "f" }); // done
    await client.asked("all");
    await client.asked("done");
    // the answer for the older filter arrives last
    client.answers.get("done")?.({ rows: [row("d", "merged")], hidden: 2 });
    await h.until((s) => ids(s).join() === "d");
    client.answers.get("all")?.({ rows: [row("a"), row("d", "merged"), row("e")] });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ids(h.state())).toEqual(["d"]);
    expect(task(h.state())?.hidden).toBe(2);
    h.shell.stop();
  });

  test("a refresh answer for a filter cycled back to is dropped", async () => {
    const held: { filter: string | undefined; resolve: (page: ViewListPage) => void }[] = [];
    class Holding extends Client {
      holding = false;
      override objects(t: string, c?: string, s?: AbortSignal, filter?: string): Promise<ViewListPage> {
        if (!this.holding) return super.objects(t, c, s, filter);
        return new Promise((resolve) => held.push({ filter, resolve }));
      }
    }
    const client = new Holding();
    const h = harness(client);
    await h.until((s) => task(s)?.list.loaded === true);
    client.holding = true;
    h.shell.key({ name: "3" });
    h.shell.key({ name: "r" }); // refresh asks for active
    for (let i = 0; i < 4; i++) h.shell.key({ name: "f" }); // back to active
    while (held.filter((x) => x.filter === "active").length < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    const mine = held.filter((x) => x.filter === "active");
    expect(mine.length).toBe(2);
    mine[0]?.resolve({ rows: [row("new")], hidden: 0 });
    await h.until((s) => ids(s).join() === "new");
    mine[1]?.resolve({ rows: [row("old")], hidden: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(ids(h.state())).toEqual(["new"]);
    h.shell.stop();
  });
});
