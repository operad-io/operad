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
  pagePosition,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { immediateClock } from "./support.ts";

const row: ViewRow = { id: "one", title: "One", state: "new", waiting: false, running: false };

class Events implements TuiEventSource {
  private readonly queue: TuiEvent[] = [];
  private waiter: ((result: IteratorResult<TuiEvent>) => void) | undefined;
  private closed = false;
  push(event: TuiEvent): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
    } else this.queue.push(event);
  }
  stop(): void {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
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

const TOC = [{ label: "one" }, { label: "two", cursor: "c1" }, { label: "three", cursor: "c2" }];

class Client implements TuiShellClient {
  edition = 1;
  cursors: (string | undefined)[] = [];
  types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    return Promise.resolve({ types: [{ type: "item", title: "Item" }] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(_t?: string, _c?: string, _s?: AbortSignal, _f?: string, level?: { readonly parent?: string | undefined }): Promise<ViewListPage> {
    if (level?.parent !== undefined) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [row] });
  }
  object(id: string): Promise<ViewObject> {
    return Promise.resolve({
      id,
      type: "item",
      link: "operad://objects/item%3Aone",
      row,
      sections: [{ id: "log", title: "Log", live: true }],
      actions: [],
    });
  }
  section(
    _id: string,
    _section: string,
    options?: { readonly cursor?: string | undefined },
  ): Promise<ViewSectionContent> {
    const cursor = options?.cursor;
    this.cursors.push(cursor);
    const at = cursor === undefined ? 0 : Number(cursor.slice(1));
    return Promise.resolve({
      markdown: `page ${at} edition ${this.edition}`,
      ...(at < 2 ? { next: `c${at + 1}` } : {}),
      ...(cursor === undefined ? { pages: TOC } : {}),
    });
  }
}

describe("a live section that was jumped to a later page", () => {
  test("a change reads it again from that page and keeps the position", async () => {
    const client = new Client();
    const events = new Events();
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
    try {
      await view.until((s) => s.tabs.find((t) => t.id === "plugin:item")?.list.loaded === true);
      shell.key({ name: "3" });
      shell.key({ name: "enter" });
      await view.until((s) => s.object?.sections[0]?.markdown === "page 0 edition 1");
      shell.key({ name: "n" });
      await view.until((s) => s.object?.sections[0]?.markdown === "page 1 edition 1");
      client.cursors = [];
      client.edition = 2;
      events.push({ kind: "change", id: "one" });
      await view.until((s) => s.object?.sections[0]?.markdown === "page 1 edition 2");
      // The refresh began at the page shown, not at the first one.
      expect(client.cursors).toEqual(["c1"]);
      const section = view.last?.object?.sections[0];
      expect(section?.pageStart).toBe(1);
      expect(pagePosition(section, view.last)).toBe("page 2/3 · two");
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});
