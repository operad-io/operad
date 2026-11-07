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


interface SectionCall {
  readonly section: string;
  readonly cursor: string | undefined;
  readonly signal: AbortSignal | undefined;
  release: () => void;
}

/** A client whose section requests wait until the test releases them. */
class Client implements TuiShellClient {
  objectCalls: string[] = [];
  sectionCalls: SectionCall[] = [];
  /** Sections whose request waits for `release`. */
  hold = new Set<string>();
  /** When true the held request ignores its abort signal. */
  ignoreAbort = false;
  suffix = "";
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
    return Promise.resolve({ rows: [row("one"), row("two")] });
  }
  object(id: string): Promise<ViewObject> {
    this.objectCalls.push(id);
    return Promise.resolve({
      id,
      type: "item",
      link: `operad://objects/item%3A${id}`,
      row: row(id),
      sections: [
        { id: "info", title: "Info" },
        { id: "pages", title: "Pages", live: true },
      ],
      actions: [],
    });
  }
  section(
    _id: string,
    section: string,
    options?: { cursor?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<ViewSectionContent> {
    const cursor = options?.cursor;
    const content: ViewSectionContent =
      section === "pages"
        ? cursor === undefined
          ? { markdown: `first${this.suffix}`, next: "2" }
          : { markdown: `second${this.suffix}` }
        : { markdown: "info" };
    if (!this.hold.has(section)) return Promise.resolve(content);
    return new Promise((resolve, reject) => {
      const call: SectionCall = {
        section,
        cursor,
        signal: options?.signal,
        release: () => resolve(content),
      };
      this.sectionCalls.push(call);
      options?.signal?.addEventListener("abort", () => {
        if (!this.ignoreAbort) reject(new Error("aborted"));
      });
    });
  }
}

async function start(width: number): Promise<{
  client: Client;
  events: Events;
  view: View;
  shell: ReturnType<typeof startShell>;
}> {
  const client = new Client();
  const events = new Events();
  const view = new View();
  const shell = startShell({
    client,
    events: () => events,
    view,
    width,
    height: 20,
    theme: "dark",
    refreshDelayMs: 0,
    followDelayMs: 0,
  });
  await view.until((state) =>
    state.tabs.find((tab) => tab.id === "type:item")?.list.loaded === true,
  );
  shell.key({ name: "3" });
  return { client, events, view, shell };
}

const pagesOf = (state: TuiState) => state.object?.sections.find((s) => s.id === "pages");

describe("a section request that is not finished", () => {
  test("switching sections and back leaves paging working", async () => {
    const { client, view, shell } = await start(120);
    try {
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.markdown === "info");
      shell.key({ name: "]" });
      await view.until((state) => pagesOf(state)?.markdown === "first");
      client.hold.add("pages");
      shell.key({ name: "pagedown" });
      await view.until((state) => pagesOf(state)?.loading === true);
      shell.key({ name: "[" });
      shell.key({ name: "]" });
      client.sectionCalls[0]?.release();
      await view.until((state) => pagesOf(state)?.markdown.includes("second") === true);
      expect(pagesOf(view.last as TuiState)?.loading).toBe(false);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("escape and a reopen do not leave the section loading", async () => {
    const { client, view, shell } = await start(120);
    try {
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.markdown === "info");
      shell.key({ name: "]" });
      await view.until((state) => pagesOf(state)?.markdown === "first");
      client.hold.add("pages");
      shell.key({ name: "pagedown" });
      await view.until((state) => pagesOf(state)?.loading === true);
      shell.key({ name: "escape" });
      await view.until((state) => state.object === undefined);
      expect(client.sectionCalls[0]?.signal?.aborted).toBe(true);
      client.hold.clear();
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.markdown === "info");
      shell.key({ name: "]" });
      await view.until((state) => pagesOf(state)?.markdown === "first");
      expect(pagesOf(view.last as TuiState)?.loading).toBe(false);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("a page that lands after the object was closed and reopened is dropped", async () => {
    const { client, view, shell } = await start(120);
    try {
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.markdown === "info");
      shell.key({ name: "]" });
      await view.until((state) => pagesOf(state)?.markdown === "first");
      client.hold.add("pages");
      client.ignoreAbort = true;
      shell.key({ name: "pagedown" });
      await view.until((state) => pagesOf(state)?.loading === true);
      shell.key({ name: "escape" });
      await view.until((state) => state.object === undefined);
      client.hold.clear();
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.markdown === "info");
      shell.key({ name: "]" });
      await view.until((state) => pagesOf(state)?.markdown === "first");
      client.sectionCalls[0]?.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pagesOf(view.last as TuiState)?.markdown).toBe("first");
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});

describe("a live refresh", () => {
  test("keeps the pages the reader scrolled to", async () => {
    const { client, events, view, shell } = await start(120);
    try {
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.markdown === "info");
      shell.key({ name: "]" });
      await view.until((state) => pagesOf(state)?.markdown === "first");
      shell.key({ name: "pagedown" });
      await view.until((state) => pagesOf(state)?.markdown.includes("second") === true);
      client.suffix = "!";
      events.push({ kind: "change", id: "one" });
      await view.until((state) => pagesOf(state)?.markdown === "first!\nsecond!");
      expect(pagesOf(view.last as TuiState)?.pages).toBe(2);
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});

describe("focus", () => {
  test("side by side the pane follows the cursor and the list keeps j and k", async () => {
    const { client, view, shell } = await start(120);
    try {
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.id === "one");
      shell.key({ name: "enter" });
      expect(client.objectCalls).toEqual(["one"]);
      shell.key({ name: "j" });
      await view.until((state) => state.object?.id === "two");
      expect(client.objectCalls).toEqual(["one", "two"]);
      shell.key({ name: "k" });
      await view.until((state) => state.object?.id === "one");
      shell.key({ name: "1" });
      await view.until((state) => state.object === undefined);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("on a narrow screen enter opens, j scrolls the object and escape goes back", async () => {
    const { client, view, shell } = await start(80);
    try {
      shell.key({ name: "j" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client.objectCalls).toEqual([]);
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.id === "two");
      shell.key({ name: "j" });
      expect((view.last as TuiState).tabs[2]?.list.cursor).toBe(1);
      shell.key({ name: "escape" });
      await view.until((state) => state.object === undefined);
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});
