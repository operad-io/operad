import { describe, expect, test } from "bun:test";
import type { TextChunk } from "@opentui/core";
import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
  ViewSectionContent,
} from "@operad-io/engine";
import {
  LIVE_DEBOUNCE_MS,
  TuiError,
  TuiUnreachableError,
  drawState,
  initialState,
  reduce,
  sectionLineCount,
  sectionViewport,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { BUILTIN_THEMES, toRgba } from "../src/theme.ts";
import { ManualClock } from "./support.ts";

const ROW: ViewRow = { id: "a", title: "A", state: "new", waiting: false, running: false };

function objectOf(): ViewObject {
  return {
    id: "a",
    type: "item",
    link: "operad://objects/a",
    row: ROW,
    sections: [{ id: "log", title: "Log", live: true }],
    actions: [],
  };
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
  readonly after?: string | undefined;
  readonly cursor?: string | undefined;
}

/** A live section that answers from the counters a test sets. */
class TailClient implements TuiShellClient {
  markdown = "one";
  mark: string | undefined = "m1";
  tail: string | undefined = "tail one";
  /** What a read with `after` answers as the delta. */
  delta = "two";
  /** What a read with `after` answers when the plugin ignored it. */
  whole = "whole";
  /** False when the plugin ignores `after` and answers with a whole page. */
  honoursAfter = true;
  failure: Error | undefined;
  sectionFailure: Error | undefined;
  readonly sectionCalls: SectionCall[] = [];
  private readonly sectionWaiters: (() => void)[] = [];

  /** Resolves when the next section read is asked for. */
  nextSection(): Promise<void> {
    return new Promise((resolve) => this.sectionWaiters.push(resolve));
  }

  types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    return Promise.resolve({ types: [{ type: "item", title: "Item" }] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(
    _type?: string,
    _cursor?: string,
    _signal?: AbortSignal,
    _filter?: string,
    level?: { readonly parent?: string | undefined },
  ): Promise<ViewListPage> {
    if (level?.parent !== undefined) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [ROW] });
  }
  object(id: string): Promise<ViewObject> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({ ...objectOf(), id });
  }
  section(
    _id: string,
    _section: string,
    options?: {
      readonly cursor?: string | undefined;
      readonly after?: string | undefined;
      readonly full?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<ViewSectionContent> {
    this.sectionCalls.push({ after: options?.after, cursor: options?.cursor });
    for (const resolve of this.sectionWaiters.splice(0)) resolve();
    if (this.sectionFailure !== undefined) return Promise.reject(this.sectionFailure);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (options?.after !== undefined) {
      return Promise.resolve(
        this.honoursAfter
          ? {
              markdown: this.delta,
              ...(this.mark === undefined ? {} : { mark: this.mark }),
              ...(this.tail === undefined ? {} : { tail: this.tail }),
              delta: true,
            }
          : {
              markdown: this.whole,
              ...(this.mark === undefined ? {} : { mark: this.mark }),
              ...(this.tail === undefined ? {} : { tail: this.tail }),
              delta: false,
            },
      );
    }
    return Promise.resolve({
      markdown: this.markdown,
      ...(this.mark === undefined ? {} : { mark: this.mark }),
      ...(this.tail === undefined ? {} : { tail: this.tail }),
    });
  }
}

/** Lets every promise already resolved run its continuation. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function start(client: TailClient): {
  readonly client: TailClient;
  readonly events: Events;
  readonly view: View;
  readonly clock: ManualClock;
  readonly shell: ReturnType<typeof startShell>;
} {
  const events = new Events();
  const view = new View();
  const clock = new ManualClock();
  const shell = startShell({
    client,
    events: () => events,
    view,
    width: 120,
    height: 24,
    theme: "dark",
    clock,
    url: "http://127.0.0.1:7480",
  });
  return { client, events, view, clock, shell };
}

async function openLog(s: ReturnType<typeof start>): Promise<void> {
  await s.view.until(
    (state) => state.tabs.find((tab) => tab.kind === "plugin")?.list.loaded === true,
  );
  s.shell.key({ name: "3" });
  s.shell.key({ name: "return" });
  await s.view.until((state) => state.object?.sections[0]?.markdown === "one");
}

async function changeAndRead(s: ReturnType<typeof start>): Promise<void> {
  const called = s.client.nextSection();
  s.events.push({ kind: "change", id: "a" });
  await settled();
  s.clock.advance(LIVE_DEBOUNCE_MS);
  await called;
  await settled();
}

const text = (styled: { readonly chunks: readonly { readonly text: string }[] }): string =>
  styled.chunks.map((part) => part.text).join("");

function weak(): string {
  return toRgba(BUILTIN_THEMES.dark.weak).toInts().join(",");
}

function coloursOf(styled: { readonly chunks: readonly TextChunk[] }, needle: string): string[] {
  return styled.chunks
    .filter((chunk) => chunk.text.includes(needle))
    .map((chunk) => (chunk.fg?.toInts() ?? []).join(","));
}

describe("a live section reads after its mark", () => {
  test("a change asks with after, appends the delta and replaces the tail", async () => {
    const s = start(new TailClient());
    try {
      await openLog(s);
      s.client.sectionCalls.length = 0;
      s.client.mark = "m2";
      s.client.tail = "tail two";
      await changeAndRead(s);
      const section = s.shell.state.object?.sections[0];
      expect(section?.markdown).toBe("one\ntwo");
      expect(section?.tail).toBe("tail two");
      expect(s.client.sectionCalls).toEqual([{ after: "m1", cursor: undefined }]);
      expect(section?.mark).toBe("m2");
    } finally {
      s.shell.stop();
      await s.shell.done;
    }
  });

  test("a whole page that ignored after replaces the content instead of appending", async () => {
    const s = start(new TailClient());
    try {
      await openLog(s);
      s.client.sectionCalls.length = 0;
      s.client.honoursAfter = false;
      s.client.whole = "fresh page";
      s.client.mark = "m2";
      s.client.tail = "tail two";
      await changeAndRead(s);
      const section = s.shell.state.object?.sections[0];
      expect(section?.markdown).toBe("fresh page");
      expect(section?.tail).toBe("tail two");
      expect(s.client.sectionCalls).toEqual([{ after: "m1", cursor: undefined }]);
      expect(section?.mark).toBe("m2");
    } finally {
      s.shell.stop();
      await s.shell.done;
    }
  });

  test("a section that gives no mark is fetched as before", async () => {
    const s = start(new TailClient());
    try {
      s.client.mark = undefined;
      await openLog(s);
      s.client.sectionCalls.length = 0;
      s.client.markdown = "one and more";
      await changeAndRead(s);
      expect(s.shell.state.object?.sections[0]?.markdown).toBe("one and more");
      expect(s.client.sectionCalls.some((call) => call.after !== undefined)).toBe(false);
      expect(s.shell.state.object?.sections[0]?.mark).toBeUndefined();
    } finally {
      s.shell.stop();
      await s.shell.done;
    }
  });

  test("after a reconnect the section is read whole once, then continues from its new mark", async () => {
    const s = start(new TailClient());
    try {
      await openLog(s);
      s.client.failure = new TuiUnreachableError("no server answered");
      s.shell.key({ name: "r" });
      await s.view.until((state) => state.connection === "unreachable");
      await settled();

      s.client.failure = undefined;
      s.client.markdown = "one recovered";
      s.client.mark = "m2";
      s.client.tail = "tail two";
      s.client.sectionCalls.length = 0;
      const called = s.client.nextSection();
      s.clock.advance(250);
      await called;
      await settled();
      expect(s.client.sectionCalls.map((call) => call.after)).toEqual([undefined]);
      expect(s.shell.state.connection).toBe("ok");
      expect(s.shell.state.object?.sections[0]?.markdown).toBe("one recovered");
      expect(s.shell.state.object?.sections[0]?.mark).toBe("m2");

      s.client.sectionCalls.length = 0;
      s.client.mark = "m3";
      s.client.tail = "tail three";
      await changeAndRead(s);
      expect(s.shell.state.object?.sections[0]?.tail).toBe("tail three");
      expect(s.client.sectionCalls).toEqual([{ after: "m2", cursor: undefined }]);
    } finally {
      s.shell.stop();
      await s.shell.done;
    }
  });
});

describe("the tail is drawn after the content", () => {
  test("it is drawn as Markdown in the weak colour, and nothing stays once it is gone", async () => {
    const s = start(new TailClient());
    try {
      await openLog(s);
      const drawn = drawState(s.shell.state, "dark").right;
      expect(text(drawn)).toContain("tail one");
      expect(coloursOf(drawn, "tail one")).toEqual([weak()]);

      s.client.tail = undefined;
      await changeAndRead(s);
      expect(s.shell.state.object?.sections[0]?.tail).toBeUndefined();
      const after = text(drawState(s.shell.state, "dark").right);
      expect(after).not.toContain("tail one");
    } finally {
      s.shell.stop();
      await s.shell.done;
    }
  });
});

/** A page with one live section, loaded with the given content and tail. */
function opened(markdown: string, tail: string): TuiState {
  let state = initialState({ width: 120, height: 16, theme: "dark" });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  state = reduce(state, {
    type: "page",
    tabId: "plugin:item",
    replace: true,
    page: { rows: [ROW] },
  });
  state = reduce(state, { type: "key", key: "3", text: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, { type: "object", object: objectOf(), version: state.objectVersion });
  const section = state.object?.sections[0];
  state = reduce(state, {
    type: "section",
    objectId: "a",
    sectionId: "log",
    content: { markdown, mark: "m1", tail },
    version: section?.version ?? 0,
  });
  return state;
}

const LINES = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join("\n");

describe("a live section follows its end as content and tail grow", () => {
  test("at the bottom it stays there; scrolled up it stays where it is", () => {
    let state = opened(LINES, "tail one");
    let section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    expect(section.following).toBe(true);
    const bottom = sectionLineCount(state, section) - sectionViewport(state);
    expect(section.scroll).toBe(bottom);
    expect(text(drawState(state, "dark").right)).toContain("tail one");

    const before = section.scroll;
    state = reduce(state, {
      type: "section",
      objectId: "a",
      sectionId: "log",
      content: { markdown: "grown", mark: "m2", tail: "tail two", delta: true },
      version: section.version,
      after: true,
    });
    section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    expect(section.following).toBe(true);
    expect(section.scroll).toBeGreaterThan(before);
    expect(section.scroll).toBe(sectionLineCount(state, section) - sectionViewport(state));
    expect(text(drawState(state, "dark").right)).toContain("tail two");

    // Page up leaves the end: a growing tail does not move the reader.
    state = reduce(state, { type: "key", key: "pageup" });
    section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    expect(section.following).toBe(false);
    const held = section.scroll;
    state = reduce(state, {
      type: "section",
      objectId: "a",
      sectionId: "log",
      content: { markdown: "grown again", mark: "m3", tail: "tail three", delta: true },
      version: section.version,
      after: true,
    });
    section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    expect(section.following).toBe(false);
    expect(section.scroll).toBe(held);
    expect(text(drawState(state, "dark").right)).not.toContain("tail three");

    // End goes back to the bottom and follows again.
    state = reduce(state, { type: "key", key: "end" });
    section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    expect(section.following).toBe(true);
    state = reduce(state, {
      type: "section",
      objectId: "a",
      sectionId: "log",
      content: { markdown: "more", mark: "m4", tail: "tail four", delta: true },
      version: section.version,
      after: true,
    });
    section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    expect(section.scroll).toBe(sectionLineCount(state, section) - sectionViewport(state));
    expect(text(drawState(state, "dark").right)).toContain("tail four");
  });
});

describe("the live tail keeps the client's guarantees", () => {
  test("a late answer for an older version is still dropped", () => {
    const state = opened(LINES, "tail one");
    const section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    // An answer is dropped, so the tail of a stale read cannot land.
    const stale = reduce(state, {
      type: "section",
      objectId: "a",
      sectionId: "log",
      content: { markdown: "stale", tail: "stale tail", delta: true },
      version: section.version + 1,
      after: true,
    });
    expect(stale).toBe(state);
  });

  test("an error after a mark is shown like any other section error", async () => {
    const s = start(new TailClient());
    try {
      await openLog(s);
      s.client.sectionFailure = new TuiError("log broke", { status: 500 });
      await changeAndRead(s);
      expect(s.shell.state.object?.sections[0]?.error).toBe("log broke");
      expect(text(drawState(s.shell.state, "dark").right)).toContain("log broke");
    } finally {
      s.shell.stop();
      await s.shell.done;
    }
  });
});
