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
  type TuiTypeInfo,
  type TuiView,
} from "../src/index.ts";
import { creationParents, paletteEntries } from "../src/actions.ts";
import { initialState, reduce } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";
import { immediateClock } from "./support.ts";

const TYPES: readonly TuiTypeInfo[] = [
  { type: "bot", title: "Bot", plugin: "bot", settings: true },
  { type: "bot-proposal", title: "Bot proposal", plugin: "bot", settings: true },
  { type: "repo", title: "Repository", plugin: "dev" },
];

function row(id: string, title: string, state = "open", parent?: string): ViewRow {
  return {
    id,
    title,
    state,
    waiting: false,
    running: false,
    ...(parent === undefined ? {} : { parent }),
  };
}

function stateWithBots(): TuiState {
  let state = reduce(initialState({ width: 120, height: 24 }), {
    type: "types",
    types: TYPES,
  });
  state = reduce(state, {
    type: "settings-objects",
    entries: [{ row: row("default", "default"), type: "bot" }],
  });
  return state;
}

describe("objects under settings", () => {
  test("the plugin gets no tab, and its objects are listed one group per type", () => {
    const state = stateWithBots();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["pending", "running", "plugin:dev"]);
    expect(state.settingsTab?.types?.map((info) => info.type)).toEqual([
      "bot",
      "bot-proposal",
    ]);
    // The top bar names no Bot tab.
    const header = drawState(state).header.chunks.map((chunk) => chunk.text).join("");
    expect(header).not.toContain("Bot");
    const entries = paletteEntries({
      ...state,
      input: { kind: "palette", query: "", cursor: 0 },
    });
    expect(
      entries
        .filter((entry) => entry.groupTitle === "Bot")
        .map((entry) => entry.name),
    ).toEqual(["default"]);
    expect(entries.find((entry) => entry.groupTitle === "Bot")?.command).toEqual({
      kind: "open",
      type: "bot",
      id: "default",
    });
    // A group is drawn for the type, named after it.
    expect(entries.some((entry) => entry.groupTitle === "Bot")).toBe(true);
    expect(entries.some((entry) => entry.groupTitle === "Bot proposal")).toBe(false);
  });

  test("a settings object is found by the group title a person sees, not its type", () => {
    let state = reduce(initialState({ width: 120, height: 24 }), {
      type: "types",
      types: [{ type: "bot", title: "Agent", plugin: "bot", settings: true }],
    });
    state = reduce(state, {
      type: "settings-objects",
      entries: [{ row: row("default", "default"), type: "bot" }],
    });
    const entries = paletteEntries({
      ...state,
      input: { kind: "palette", query: "Agent", cursor: 0 },
    });
    expect(entries.map((entry) => entry.name)).toEqual(["default"]);
  });

  test("Enter opens the bot's page; the chat entry can start a chat on it", () => {
    let state = reduce(stateWithBots(), { type: "key", key: ":", text: ":" });
    state = {
      ...state,
      input: { kind: "palette", query: "default", cursor: 0 },
    };
    state = reduce(state, { type: "key", key: "enter" });
    expect(state.objectRequest?.id).toBe("bot:default");
    expect(creationParents(state, "chat", ["bot"])).toContain("bot:default");
  });

  test("a settings object that heads a group in the chat tab opens from that heading", () => {
    let state = reduce(initialState({ width: 120, height: 24 }), {
      type: "types",
      types: [...TYPES, { type: "chat", title: "Chat", plugin: "chat" }],
    });
    state = reduce(state, {
      type: "tree",
      tabId: "plugin:chat",
      level: "children",
      entries: [
        {
          row: row("C-0001", "First chat", "open", "bot:default"),
          type: "chat",
          parent: "bot:default",
          heading: {
            row: row("bot:default", "bot:default"),
            type: "bot",
            label: "bot:default",
          },
        },
      ],
    });
    const chat = state.tabs.find((tab) => tab.id === "plugin:chat");
    expect(chat?.list.rows.map((entry) => entry.id)).toEqual(["bot:default", "C-0001"]);
    expect(chat?.list.rows[0]?.heading).toBe(true);
    expect(chat?.list.rows[1]?.group).toBeUndefined();
    expect(chat?.list.rows[1]?.grouped).toBe(true);
    const at = state.tabs.findIndex((tab) => tab.id === "plugin:chat");
    state = reduce(state, { type: "key", key: String(at + 1) });
    state = reduce(state, { type: "key", key: "enter" });
    expect(state.objectRequest?.id).toBe("bot:default");
  });

  test("two settings types with one display title keep separate palette groups", () => {
    let state = reduce(initialState({ width: 100, height: 30 }), {
      type: "types",
      types: [
        { type: "foo-bar", title: "Foo Bar", plugin: "demo", settings: true },
        { type: "foo_bar", title: "Foo Bar", plugin: "demo", settings: true },
      ],
    });
    state = reduce(state, {
      type: "settings-objects",
      entries: [
        { row: row("one", "one"), type: "foo-bar" },
        { row: row("two", "two"), type: "foo_bar" },
      ],
    });
    state = reduce(state, { type: "key", key: ":", text: ":" });
    const entries = paletteEntries(state).filter((entry) => entry.groupTitle === "Foo Bar");
    expect(entries.map((entry) => entry.name)).toEqual(["one", "two"]);
    expect(new Set(entries.map((entry) => entry.group)).size).toBe(2);
    const drawn = drawState(state, "dark").overlay?.chunks.map((chunk) => chunk.text).join("") ?? "";
    expect(drawn.match(/Foo Bar/g)?.length).toBe(2);
  });

  test("opening a bot loads its own page and the next level under it", async () => {
    const view = new View();
    const shell = startShell({
      client: new SettingsClient(),
      events: () => new NoEvents(),
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: immediateClock,
    });
    await view.until((state) => state.settingsTab?.list.loaded === true);
    expect(shell.state.settingsTab?.list.rows.map((row) => row.id)).toEqual(["default"]);
    shell.key({ name: ":", sequence: ":" });
    for (const char of "default") shell.key({ name: char, sequence: char });
    shell.key({ name: "enter" });
    await view.until((state) => state.object?.children !== undefined);
    expect(shell.state.object?.type).toBe("bot");
    expect(shell.state.object?.children?.rows.map((row) => row.id)).toEqual(["p-1"]);
    shell.stop();
  });
});

class SettingsClient implements TuiShellClient {
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
    if (type === "bot" && level?.root === true) {
      return Promise.resolve({ rows: [row("default", "default")] });
    }
    if (type === "bot-proposal" && level?.parent === "bot:default") {
      return Promise.resolve({ rows: [row("p-1", "A proposal", "pending")] });
    }
    return Promise.resolve({ rows: [] });
  }
  object(id: string): Promise<ViewObject> {
    const [type = "", bare = ""] = id.split(":");
    return Promise.resolve({
      id: bare,
      type,
      link: "",
      row: row(bare, bare),
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
