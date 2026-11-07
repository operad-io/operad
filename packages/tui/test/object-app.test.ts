import { describe, expect, test } from "bun:test";
import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewSectionContent,
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

function row(id: string, title = `Title ${id}`): ViewRow {
  return { id, title, state: "new", waiting: false, running: false };
}

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

class Client implements TuiShellClient {
  objectCalls: string[] = [];
  sectionCalls: { id: string; section: string }[] = [];
  changed = false;
  types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    return Promise.resolve({ types: [{ type: "item", title: "Item" }] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(): Promise<ViewListPage> {
    return Promise.resolve({ rows: [row("one")] });
  }
  object(id: string): Promise<ViewObject> {
    this.objectCalls.push(id);
    return Promise.resolve({
      id,
      type: "item",
      link: "operad://objects/item%3Aone",
      row: row(id, this.changed ? "Changed" : "One"),
      sections: [
        { id: "info", title: "Info" },
        { id: "pages", title: "Pages", live: true },
        { id: "history", title: "History" },
      ],
      actions: [],
    });
  }
  section(id: string, section: string): Promise<ViewSectionContent> {
    this.sectionCalls.push({ id, section });
    if (section === "pages") {
      return Promise.resolve({ markdown: this.changed ? "pages changed" : "pages one" });
    }
    return Promise.resolve({ markdown: "info one" });
  }
}

describe("the TUI object app", () => {
  test("Enter fetches the object and its section; a change refreshes both", async () => {
    const client = new Client();
    const events = new Events();
    const view = new View();
    const shell = startShell({
      client,
      events: () => events,
      view,
      width: 80,
      height: 20,
      theme: "dark",
      refreshDelayMs: 0,
    });
    try {
      await view.until((state) =>
        state.tabs.find((tab) => tab.id === "type:item")?.list.loaded === true,
      );
      shell.key({ name: "3" });
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.row.title === "One");
      expect(client.objectCalls).toEqual(["one"]);
      await view.until(
        (state) => state.object?.sections[0]?.markdown === "info one",
      );

      shell.key({ name: "]" });
      await view.until(
        (state) => state.object?.sections[1]?.markdown === "pages one",
      );

      client.changed = true;
      events.push({ kind: "change", id: "one" });
      await view.until((state) => state.object?.row.title === "Changed");
      await view.until(
        (state) =>
          state.object?.sections[1]?.markdown === "pages changed" &&
          state.object.sections[1].following === true,
      );
      expect(client.objectCalls.length).toBeGreaterThanOrEqual(2);
      expect(client.sectionCalls.filter((call) => call.section === "pages").length).toBeGreaterThanOrEqual(2);
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});
