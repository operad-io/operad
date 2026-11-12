import { describe, expect, test } from "bun:test";
import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
} from "@operad-io/engine";
import {
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { displayChildren } from "../src/state.ts";
import { BUILTIN_THEMES, toRgba } from "../src/theme.ts";
import { drawState } from "../src/view/index.ts";
import { immediateClock } from "./support.ts";

const PLUGIN = "demo";

const REPO_FILTERS = [
  { name: "active", states: ["active"] },
  { name: "all" },
] as const;
const PLAN_FILTERS = [
  { name: "active", states: ["active"] },
  { name: "all" },
  { name: "done", states: ["finished"] },
] as const;
const TASK_FILTERS = [
  { name: "active", states: ["proposed", "running", "waiting"] },
  { name: "all" },
  { name: "done", states: ["merged"] },
  { name: "cancelled", states: ["cancelled"] },
] as const;

const FILTERS: Readonly<
  Record<string, readonly { readonly name: string; readonly states?: readonly string[] | undefined }[]>
> = { repo: REPO_FILTERS, plan: PLAN_FILTERS, task: TASK_FILTERS };

const TYPES = [
  { type: "repo", title: "Repo", plugin: PLUGIN, filters: REPO_FILTERS, defaultFilter: "active" },
  { type: "plan", title: "Plan", plugin: PLUGIN, filters: PLAN_FILTERS, defaultFilter: "active" },
  { type: "task", title: "Task", plugin: PLUGIN, filters: TASK_FILTERS, defaultFilter: "active" },
] as const;

interface Stored {
  readonly type: string;
  readonly row: ViewRow;
  readonly parent?: string;
}

function entry(type: string, id: string, state: string, parent?: string, extra: Partial<ViewRow> = {}): Stored {
  return {
    type,
    row: { id, title: `Title ${id}`, state, waiting: false, running: false, ...extra },
    ...(parent === undefined ? {} : { parent }),
  };
}

/** One repository, one plan, and a task in each of the three states. */
const DATA: readonly Stored[] = [
  entry("repo", "r1", "active"),
  entry("plan", "p1", "active", "repo:r1"),
  entry("task", "t-cancelled", "cancelled", "plan:p1", { mark: "cancelled" }),
  entry("task", "t-active", "running", "plan:p1", { mark: "running" }),
  entry("task", "t-merged", "merged", "plan:p1", { mark: "done" }),
];

function shows(type: string, filter: string, state: string): boolean {
  const states = FILTERS[type]?.find((one) => one.name === filter)?.states;
  if (states === undefined) return true;
  return state === "error" || states.includes(state);
}

interface Asked {
  readonly type: string;
  readonly filter?: string | undefined;
  readonly parent?: string | undefined;
  readonly root?: boolean | undefined;
}

/** A server of a plugin with repository, plan and task types, each with filters. */
class Client implements TuiShellClient {
  readonly asked: Asked[] = [];
  private readonly waiters: { test: (one: Asked) => boolean; resolve: () => void }[] = [];
  /** Resolves once a request matching `test` has been made. */
  when(test: (one: Asked) => boolean): Promise<void> {
    if (this.asked.some(test)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
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
    filter?: string,
    level?: { readonly root?: boolean | undefined; readonly parent?: string | undefined },
  ): Promise<ViewListPage> {
    this.asked.push({
      type,
      ...(filter === undefined ? {} : { filter }),
      ...(level?.parent === undefined ? {} : { parent: level.parent }),
      ...(level?.root === true ? { root: true } : {}),
    });
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.test(this.asked[this.asked.length - 1] as Asked)) waiter.resolve();
      else this.waiters.push(waiter);
    }
    const under = DATA.filter((one) => one.type === type)
      .filter((one) => (level?.root === true ? one.parent === undefined : true))
      .filter((one) => level?.parent === undefined || one.parent === level.parent);
    const shown =
      filter === undefined || filter === "all"
        ? under
        : under.filter((one) => shows(type, filter, one.row.state));
    const hiddenRows = under.filter((one) => !shown.includes(one));
    const hiddenDone = hiddenRows.filter((one) => /^(done|merged)$/i.test(one.row.state)).length;
    const hiddenCancelled = hiddenRows.filter((one) => /cancelled$/i.test(one.row.state)).length;
    return Promise.resolve({
      rows: shown.map((one) => one.row),
      ...(hiddenRows.length === 0
        ? {}
        : {
            hidden: hiddenRows.length,
            hiddenCounts: {
              done: hiddenDone,
              cancelled: hiddenCancelled,
              other: hiddenRows.length - hiddenDone - hiddenCancelled,
            },
          }),
    });
  }
  object(id: string): Promise<ViewObject> {
    const colon = id.indexOf(":");
    const type = colon < 0 ? "" : id.slice(0, colon);
    const bare = colon < 0 ? id : id.slice(colon + 1);
    const found = DATA.find(
      (one) => one.row.id === bare && (type === "" || one.type === type),
    );
    if (found === undefined) return Promise.reject(new Error(`no ${id}`));
    return Promise.resolve({
      id: bare,
      type: found.type,
      link: "",
      row: found.row,
      sections: [],
      actions: [],
    });
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
  private readonly waiters: { test: (state: TuiState) => boolean; resolve: () => void }[] = [];
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

const tabOf = (state: TuiState) => state.tabs.find((tab) => tab.id === `plugin:${PLUGIN}`);
const childIds = (state: TuiState): readonly string[] => {
  const rows = state.object?.children?.rows ?? [];
  return displayChildren(rows, state.childLayout).map((one) => one.row.id);
};
const rightText = (state: TuiState): string =>
  drawState(state).right.chunks.map((chunk) => chunk.text).join("");
const colour = (name: keyof typeof BUILTIN_THEMES.dark): string =>
  toRgba(BUILTIN_THEMES.dark[name]).toInts().join(",");

describe("an open plan's next level is every one of its tasks", () => {
  test("all tasks show under the tab's active filter, the counts match, and f keeps them", async () => {
    const client = new Client();
    const view = new View();
    const shell = startShell({
      client,
      events: () => new NoEvents(),
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: immediateClock,
    });
    try {
      await view.until((state) => tabOf(state)?.list.loaded === true);
      shell.key({ name: "3" });
      await view.until(
        (state) => state.object?.id === "p1" && state.object.children !== undefined,
      );

      // Every task, in the child list's order: the cancelled one last.
      expect(childIds(shell.state)).toEqual(["t-active", "t-merged", "t-cancelled"]);
      const right = rightText(shell.state);
      expect(right).toContain("t-active");
      expect(right).toContain("t-merged");
      expect(right).toContain("t-cancelled");

      // One merged of two counted children; the cancelled one is outside total.
      const heading = right.split("\n").find((line) => line.includes(" / "));
      expect(heading?.trimEnd()).toEndWith("1 / 2");
      expect(shell.state.object?.children?.hidden).toBeUndefined();
      const cells = drawState(shell.state).right.chunks.filter((chunk) => /^█+$/.test(chunk.text));
      expect(cells.length).toBe(2);
      expect(cells[0]?.fg?.toInts().join(",")).toBe(colour("ok"));
      expect(cells[1]?.fg?.toInts().join(",")).toBe(colour("cancelled"));

      // The next level was fetched under `all`, never under the tab's filter.
      const children = client.asked.filter((one) => one.parent === "plan:p1");
      expect(children.length).toBeGreaterThan(0);
      expect(children.every((one) => one.filter === "all")).toBe(true);

      // `f` cycles the left list only: the open plan and its tasks stay as they are.
      const version = tabOf(shell.state)?.list.version ?? 0;
      const before = client.asked.filter((one) => one.parent === "plan:p1").length;
      shell.key({ name: "f" });
      await client.when((one) => one.parent === "repo:r1" && one.filter === "all");
      await view.until((state) => {
        const tab = tabOf(state);
        return (
          tab?.filter === "all" &&
          tab.list.switching !== true &&
          (tab.list.version ?? 0) > version
        );
      });
      expect(tabOf(shell.state)?.filter).toBe("all");
      expect(client.asked.some((one) => one.parent === "repo:r1" && one.filter === "all")).toBe(true);
      expect(shell.state.object?.id).toBe("p1");
      expect(childIds(shell.state)).toEqual(["t-active", "t-merged", "t-cancelled"]);
      expect(client.asked.filter((one) => one.parent === "plan:p1").length).toBe(before);
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});
