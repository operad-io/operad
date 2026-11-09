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
import { ManualClock } from "./support.ts";

const ids = ["a", "b", "c", "d"];
const row = (id: string): ViewRow => ({
  id,
  title: `Title ${id}`,
  state: "new",
  waiting: false,
  running: false,
});

class Silent implements TuiEventSource {
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

class Client implements TuiShellClient {
  objectCalls: string[] = [];
  private readonly held = new Map<string, (object: ViewObject) => void>();
  hold = false;
  holdList: (() => void) | undefined;
  listGate: Promise<void> | undefined;
  rows: ViewRow[] = ids.map(row);
  types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    return Promise.resolve({ types: [{ type: "item", title: "Item" }] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  async objects(): Promise<ViewListPage> {
    await this.listGate;
    return { rows: this.rows };
  }
  object(id: string): Promise<ViewObject> {
    this.objectCalls.push(id);
    const answer: ViewObject = {
      id,
      type: "item",
      link: "",
      row: row(id.slice(id.indexOf(":") + 1)),
      sections: [{ id: "info", title: "Info" }],
      actions: [],
    };
    if (!this.hold) return Promise.resolve(answer);
    return new Promise((resolve) => this.held.set(id, resolve.bind(null, answer)));
  }
  release(id: string): void {
    this.held.get(id)?.({} as ViewObject);
  }
  section(): Promise<ViewSectionContent> {
    return Promise.resolve({ markdown: "info" });
  }
}

async function start(width: number, rows?: ViewRow[]) {
  const client = new Client();
  if (rows !== undefined) client.rows = rows;
  const view = new View();
  const clock = new ManualClock();
  const shell = startShell({
    client,
    events: () => new Silent(),
    view,
    width,
    height: 20,
    theme: "dark",
    clock,
    followDelayMs: 100,
  });
  await view.until((s) => s.tabs.find((t) => t.id === "type:item")?.list.loaded === true);
  shell.key({ name: "3" });
  return { client, view, shell, clock };
}

describe("the object pane follows the cursor", () => {
  test("a list that loads under the open tab shows its first row", async () => {
    const client = new Client();
    client.listGate = new Promise((resolve) => {
      client.holdList = resolve;
    });
    const view = new View();
    const clock = new ManualClock();
    const shell = startShell({
      client,
      events: () => new Silent(),
      view,
      width: 120,
      height: 20,
      theme: "dark",
      clock,
      followDelayMs: 100,
    });
    try {
      await view.until((s) => s.tabs.some((t) => t.id === "type:item"));
      shell.key({ name: "3" });
      client.holdList?.();
      await view.until((s) => s.tabs.find((t) => t.id === "type:item")?.list.loaded === true);
      clock.advance(100);
      await view.until((s) => s.object?.id === "item:a" && !s.object.loading);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("the first row is shown when the list loads", async () => {
    const { client, view, shell, clock } = await start(120);
    try {
      expect(client.objectCalls).toEqual([]);
      clock.advance(100);
      await view.until((s) => s.object?.id === "item:a" && !s.object.loading);
      expect(client.objectCalls).toEqual(["item:a"]);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("three fast moves fetch only the last row", async () => {
    const { client, view, shell, clock } = await start(120);
    try {
      clock.advance(100);
      await view.until((s) => s.object?.id === "item:a" && !s.object.loading);
      shell.key({ name: "j" });
      clock.advance(50);
      shell.key({ name: "j" });
      clock.advance(50);
      shell.key({ name: "j" });
      expect(client.objectCalls).toEqual(["item:a"]);
      clock.advance(100);
      await view.until((s) => s.object?.id === "item:d" && !s.object.loading);
      expect(client.objectCalls).toEqual(["item:a", "item:d"]);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("a late reply for a row the cursor left is dropped", async () => {
    const { client, view, shell, clock } = await start(120);
    try {
      client.hold = true;
      clock.advance(100);
      await view.until(() => client.objectCalls.length === 1);
      shell.key({ name: "j" });
      clock.advance(100);
      await view.until(() => client.objectCalls.length === 2);
      client.release("item:b");
      await view.until((s) => s.object?.id === "item:b" && !s.object.loading);
      client.release("item:a");
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(view.last?.object?.id).toBe("item:b");
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("an empty list still says to select an object", async () => {
    const { client, view, shell, clock } = await start(120, []);
    try {
      clock.advance(100);
      expect(client.objectCalls).toEqual([]);
      expect(view.last?.object).toBeUndefined();
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("one pane opens nothing until enter", async () => {
    const { client, view, shell, clock } = await start(80);
    try {
      shell.key({ name: "j" });
      clock.advance(1000);
      expect(client.objectCalls).toEqual([]);
      shell.key({ name: "enter" });
      await view.until((s) => s.object?.id === "item:b");
      expect(client.objectCalls).toEqual(["item:b"]);
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});
