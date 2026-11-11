import { describe, expect, test } from "bun:test";
import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
  ViewSectionContent,
} from "@operad-io/engine";
import {
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { initialState, listWidth, listWidthFor, reduce } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";
import { immediateClock } from "./support.ts";

const TYPES = [
  { type: "repo", title: "Repository", plugin: "dev" },
  { type: "plan", title: "Plan", plugin: "dev" },
  { type: "task", title: "Task", plugin: "dev" },
  { type: "note", title: "Note", plugin: "notes" },
];

interface Stored {
  readonly type: string;
  readonly row: ViewRow;
  readonly parent?: string;
}

function entry(type: string, id: string, title: string, parent?: string, note?: string): Stored {
  return {
    type,
    row: {
      id,
      title,
      state: "active",
      ...(note === undefined ? {} : { note }),
      waiting: false,
      running: false,
      ...(parent === undefined ? {} : { parent }),
    },
    ...(parent === undefined ? {} : { parent }),
  };
}

const DATA: readonly Stored[] = [
  entry("repo", "ops", "Operations"),
  entry("repo", "web", "Website"),
  entry("plan", "ops/P-0001-alpha", "Alpha plan", "repo:ops", "2 tasks"),
  entry("plan", "ops/P-0002-beta", "Beta plan", "repo:ops"),
  entry("plan", "web/P-0003-gamma", "Gamma plan", "repo:web"),
  entry("task", "ops/T-0001-first", "First task", "plan:ops/P-0001-alpha", "work 2m"),
  entry("task", "ops/T-0002-second", "Second task", "plan:ops/P-0001-alpha"),
  entry("note", "n1", "Note one"),
  entry("note", "n2", "Note two"),
];

/** A server of two plugins: `dev` is a tree, `notes` is flat. */
class TreeClient implements TuiShellClient {
  constructor(private readonly data: readonly Stored[] = DATA) {}
  types() {
    return Promise.resolve({ types: TYPES });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(
    type: string,
    _cursor?: string,
    _signal?: AbortSignal,
    _filter?: string,
    level?: { readonly root?: boolean | undefined; readonly parent?: string | undefined },
  ): Promise<ViewListPage> {
    const rows = this.data
      .filter((one) => one.type === type)
      .filter((one) => (level?.root === true ? one.parent === undefined : true))
      .filter((one) => (level?.parent === undefined ? true : one.parent === level.parent))
      .map((one) => one.row);
    return Promise.resolve({ rows });
  }
  object(id: string): Promise<ViewObject> {
    const colon = id.indexOf(":");
    const type = id.slice(0, colon);
    const bare = id.slice(colon + 1);
    const found = this.data.find((one) => one.type === type && one.row.id === bare);
    if (found === undefined) return Promise.reject(new Error(`no ${id}`));
    return Promise.resolve({
      id: bare,
      type,
      link: "",
      row: found.row,
      sections: [{ id: "info", title: "Info" }],
      actions: [],
    });
  }
  section(): Promise<ViewSectionContent> {
    return Promise.resolve({ markdown: "text" });
  }
}

class NoEvents implements TuiEventSource {
  stop(): void {}
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return { next: () => new Promise(() => undefined) };
  }
}

class View implements TuiView {
  last: TuiState | undefined;
  private readonly waiters: { test: (s: TuiState) => boolean; resolve: () => void }[] = [];
  render(state: TuiState): void {
    this.last = state;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.test(state)) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }
  destroy(): void {}
  until(test: (state: TuiState) => boolean): Promise<void> {
    if (this.last !== undefined && test(this.last)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
}

function open(client: TuiShellClient = new TreeClient(), width = 120) {
  const view = new View();
  const shell = startShell({
    client,
    events: () => new NoEvents(),
    view,
    width,
    height: 30,
    theme: "dark",
    clock: immediateClock,
  });
  return { view, shell };
}

const text = (chunks: { readonly chunks: readonly { readonly text: string }[] }): string =>
  chunks.chunks.map((c) => c.text).join("");
const tabOf = (state: TuiState, id: string) => state.tabs.find((tab) => tab.id === id);

describe("one tab per plugin", () => {
  test("the header has Pending, Running and one tab per plugin, named by the plugin", () => {
    const state = reduce(initialState({ width: 120, height: 24 }), {
      type: "types",
      types: TYPES,
    });
    expect(state.tabs.map((tab) => tab.title)).toEqual(["Pending", "Running", "dev", "notes"]);
    expect(state.tabs.map((tab) => tab.id)).toEqual([
      "pending",
      "running",
      "plugin:dev",
      "plugin:notes",
    ]);
    expect(text(drawState(state).header)).toContain("Pending 0 · Running 0 · dev · notes");
    // A plugin's types are on its tab, not tabs of their own.
    expect(tabOf(state, "plugin:dev")?.types?.map((t) => t.type)).toEqual(["repo", "plan", "task"]);
  });

  test("roots that all have children list the children, grouped by root", async () => {
    const { view, shell } = open();
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    const dev = tabOf(shell.state, "plugin:dev");
    expect(dev?.level).toBe("children");
    expect(dev?.list.rows.map((row) => row.id)).toEqual([
      "ops/P-0001-alpha",
      "ops/P-0002-beta",
      "web/P-0003-gamma",
    ]);
    expect(dev?.list.rows.map((row) => row.group?.id)).toEqual(["ops", undefined, "web"]);
    shell.key({ name: "3" });
    const list = text(drawState(shell.state).list);
    // A heading for each root, the plan rows by id and slug only, no title.
    expect(list).toContain("ops");
    expect(list).toContain("web");
    expect(list).toContain("P-0001 alpha");
    expect(list).not.toContain("Alpha plan");
    expect(list.indexOf("ops")).toBeLessThan(list.indexOf("P-0001 alpha"));
    expect(list.indexOf("P-0002 beta")).toBeLessThan(list.indexOf("web"));
    // The heading is not a row: the cursor goes from one plan to the next.
    shell.key({ name: "down" });
    shell.key({ name: "down" });
    expect(tabOf(shell.state, "plugin:dev")?.list.cursor).toBe(2);
    shell.stop();
  });

  test("a group with one root still shows its heading", async () => {
    const one = DATA.filter((one) => one.row.id !== "web" && one.row.id !== "web/P-0003-gamma");
    const { view, shell } = open(new TreeClient(one));
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    shell.key({ name: "3" });
    expect(tabOf(shell.state, "plugin:dev")?.list.rows[0]?.group?.id).toBe("ops");
    expect(text(drawState(shell.state).list)).toContain("ops");
    shell.stop();
  });

  test("roots without children are listed themselves", async () => {
    const { view, shell } = open();
    await view.until((state) => tabOf(state, "plugin:notes")?.list.loaded === true);
    const notes = tabOf(shell.state, "plugin:notes");
    expect(notes?.level).toBe("roots");
    expect(notes?.list.rows.map((row) => row.id)).toEqual(["n1", "n2"]);
    expect(notes?.list.rows.every((row) => row.group === undefined)).toBe(true);
    shell.stop();
  });

  test("a repository with no plans is still a group row among the grouped plans", async () => {
    const { view, shell } = open(new TreeClient([...DATA, entry("repo", "empty", "Empty")]));
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    shell.key({ name: "3" });
    const dev = tabOf(shell.state, "plugin:dev");
    expect(dev?.level).toBe("children");
    expect(dev?.list.rows.map((row) => row.id)).toEqual([
      "ops/P-0001-alpha",
      "ops/P-0002-beta",
      "web/P-0003-gamma",
      "empty",
    ]);
    expect(dev?.list.rows.map((row) => row.group?.id)).toEqual(["ops", undefined, "web", undefined]);
    expect(dev?.list.rows[3]?.bare).toBe(true);
    const list = text(drawState(shell.state).list);
    expect(list).toContain("empty");
    expect(list.indexOf("P-0003 gamma")).toBeLessThan(list.indexOf("empty"));
    // A plan opens with its tasks, and a task from there, and back.
    await view.until((state) => state.object?.id === "ops/P-0001-alpha" && state.object.children !== undefined);
    shell.key({ name: "enter" });
    shell.key({ name: "enter" });
    await view.until((state) => state.object?.id === "ops/T-0001-first" && !state.object.loading);
    shell.key({ name: "escape" });
    await view.until((state) => state.object?.id === "ops/P-0001-alpha");
    // The empty repository can be opened.
    shell.key({ name: "escape" });
    shell.key({ name: "escape" });
    for (let i = 0; i < 3; i++) shell.key({ name: "down" });
    await view.until((state) => state.object?.id === "empty");
    shell.stop();
  });

  test("zero next level anywhere keeps the roots list", async () => {
    const roots = DATA.filter((one) => one.type === "repo");
    const { view, shell } = open(new TreeClient([...roots, entry("repo", "empty", "Empty")]));
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    const dev = tabOf(shell.state, "plugin:dev");
    expect(dev?.level).toBe("roots");
    expect(dev?.list.rows.map((row) => row.id)).toEqual(["ops", "web", "empty"]);
    shell.stop();
  });

  test("enter on a child in the page opens its own page, and back returns to the plan", async () => {
    const { view, shell } = open();
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    shell.key({ name: "3" });
    // The pane follows the cursor: the first plan's page, with its tasks.
    await view.until((state) => state.object?.id === "ops/P-0001-alpha" && state.object.children !== undefined);
    expect(shell.state.object?.children?.rows.map((row) => row.id)).toEqual([
      "ops/T-0001-first",
      "ops/T-0002-second",
    ]);
    const page = text(drawState(shell.state).right);
    expect(page).toContain("T-0001-first");
    expect(page).toContain("T-0002-second");
    expect(page).toContain("TASK");
    expect(page).toContain("0 / 2");

    shell.key({ name: "enter" }); // into the page's list
    expect(shell.state.object?.children?.focused).toBe(true);
    shell.key({ name: "down" });
    shell.key({ name: "enter" }); // opens the second task
    await view.until((state) => state.object?.id === "ops/T-0002-second" && !state.object.loading);
    expect(shell.state.object?.back?.id).toBe("ops/P-0001-alpha");
    // The left list still shows the plan it came from.
    expect(tabOf(shell.state, "plugin:dev")?.list.rows[0]?.id).toBe("ops/P-0001-alpha");

    shell.key({ name: "escape" });
    await view.until(
      (state) => state.object?.id === "ops/P-0001-alpha" && state.object.children?.focused === true,
    );
    expect(shell.state.object?.back).toBeUndefined();
    expect(shell.state.object?.children?.cursor).toBe(1);
    // Escape again leaves the page's list, and once more closes the page.
    shell.key({ name: "escape" });
    expect(shell.state.object?.children?.focused).toBe(false);
    shell.key({ name: "escape" });
    expect(shell.state.object).toBeUndefined();
    shell.stop();
  });

  test("Pending and Running keep their own rows and the terminal's share of width", async () => {
    const { view, shell } = open();
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    expect(shell.state.tabs[0]?.title).toBe("Pending");
    expect(shell.state.tabs[1]?.title).toBe("Running");
    expect(listWidth(shell.state)).toBe(listWidthFor(120));
    shell.stop();
  });

  test("a plugin column is as wide as its rows, never wider than the terminal's share", async () => {
    const { view, shell } = open(new TreeClient(), 200);
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    shell.key({ name: "3" });
    // The longest line is `    work 2m`-like or the id and slug: well under 60.
    expect(listWidth(shell.state)).toBeLessThan(listWidthFor(200));
    expect(listWidth(shell.state)).toBeGreaterThanOrEqual("    P-0003 gamma".length);
    shell.stop();
    const long = new TreeClient([
      ...DATA,
      entry("plan", "ops/P-0009-long", "Long", "repo:ops", "a note that is far wider than any column could ever be".repeat(2)),
    ]);
    const wide = open(long, 200);
    await wide.view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    wide.shell.key({ name: "3" });
    expect(listWidth(wide.shell.state)).toBe(listWidthFor(200));
    wide.shell.stop();
  });

  test("a refresh of the left list leaves a child's page open", () => {
    const plan = DATA[2] as Stored;
    const task = DATA[5] as Stored;
    const entries = [{ row: plan.row, type: "plan", parent: "ops", heading: { row: (DATA[0] as Stored).row, type: "repo" } }];
    let state = reduce(initialState({ width: 120, height: 24 }), { type: "types", types: TYPES });
    state = reduce(state, { type: "tree", tabId: "plugin:dev", level: "children", entries });
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, { type: "key", key: "enter" });
    const view = (stored: Stored): ViewObject => ({
      id: stored.row.id,
      type: stored.type,
      link: "",
      row: stored.row,
      sections: [{ id: "info", title: "Info" }],
      actions: [],
    });
    state = reduce(state, { type: "object", object: view(plan), version: state.objectVersion });
    state = reduce(state, {
      type: "children",
      objectId: plan.row.id,
      entries: [{ row: task.row, type: "task" }],
    });
    state = reduce(state, { type: "key", key: "enter" });
    state = reduce(state, { type: "key", key: "enter" });
    expect(state.object?.id).toBe(`task:${task.row.id}`);
    const before = state.moveSeq;
    state = reduce(state, { type: "tree", tabId: "plugin:dev", level: "children", entries });
    expect(state.object?.id).toBe(`task:${task.row.id}`);
    expect(state.followPending).toBe(false);
    expect(state.moveSeq).toBe(before);
  });

  test("a change to a child refreshes its row on the open plan page", async () => {
    const data: Stored[] = [...DATA];
    const client = new TreeClient(data);
    // A source the test pushes one change into.
    let push: (event: TuiEvent) => void = () => undefined;
    const events: TuiEventSource = {
      stop() {},
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((resolve) => (push = (value) => resolve({ done: false, value }))),
      }),
    };
    const view = new View();
    const shell = startShell({
      client,
      events: () => events,
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: immediateClock,
    });
    await view.until((state) => tabOf(state, "plugin:dev")?.list.loaded === true);
    shell.key({ name: "3" });
    await view.until((state) => state.object?.children?.rows.length === 2);
    const index = data.findIndex((one) => one.row.id === "ops/T-0001-first");
    const old = data[index] as Stored;
    data[index] = { ...old, row: { ...old.row, state: "running", note: "work 9m" } };
    push({ kind: "change", id: "task:ops/T-0001-first" });
    await view.until((state) => state.object?.children?.rows[0]?.state === "running");
    expect(shell.state.object?.children?.rows[0]?.note).toBe("work 9m");
    shell.stop();
  });
});
