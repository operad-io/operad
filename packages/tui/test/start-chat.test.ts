import { describe, expect, test } from "bun:test";
import type {
  PendingItem,
  RunningItem,
  ViewAction,
  ViewListPage,
  ViewObject,
  ViewSectionContent,
  ViewRow,
} from "@operad-io/engine";
import {
  initialState,
  reduce,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { immediateClock } from "./support.ts";

const room = (id: string): ViewRow => ({
  id,
  title: id,
  state: "open",
  waiting: false,
  running: false,
});

const chat: ViewAction = {
  plugin: "bot",
  action: "chat",
  name: "bot:chat",
  on: "bot",
  creates: "chat",
  note: "message",
  noteRequired: true,
  confirm: false,
  args: {
    type: "object",
    properties: {
      agent: { type: "string", enum: ["pi"], default: "pi" },
      message: { type: "string", role: "note", minLength: 1 },
    },
    required: ["agent"],
    additionalProperties: false,
  },
};

function bot(): ViewObject {
  return {
    id: "bot:default",
    type: "bot",
    link: "",
    row: room("bot:default"),
    sections: [],
    actions: [chat],
  };
}

describe("a client with no chosen parent starts the default bot's new chat", () => {
  test("the parent opens, then the first-message input is ready with the arguments left at their defaults", () => {
    let state = initialState({ width: 120 });
    state = reduce(state, {
      type: "types",
      types: [
        { type: "bot", title: "Bot", plugin: "bot", settings: true },
        { type: "chat", title: "Chat", plugin: "chat", parents: ["bot"] },
      ],
    });
    state = reduce(state, { type: "start-chat", parent: "bot:default" });
    expect(state.object?.id).toBe("bot:default");
    expect(state.objectRequest?.id).toBe("bot:default");
    expect(state.creating).toEqual({ parent: "bot:default", type: "chat", noteFirst: true, mainFirst: true });

    state = reduce(state, { type: "object", object: bot() });
    expect(state.creating).toBeUndefined();
    expect(state.input).toEqual({
      kind: "note",
      action: "bot:chat",
      id: "bot:default",
      text: "",
      required: true,
      confirm: false,
    });

    for (const char of "hello") {
      state = reduce(state, { type: "key", key: char, text: char });
    }
    state = reduce(state, { type: "key", key: "enter" });
    expect(state.actionRequest).toEqual({
      action: "bot:chat",
      id: "bot:default",
      note: "hello",
    });
  });
});

describe("a bot page that names a main chat opens it instead of a new one", () => {
  function started(): TuiState {
    let state = initialState({ width: 120 });
    state = reduce(state, {
      type: "types",
      types: [
        { type: "bot", title: "Bot", plugin: "bot", settings: true },
        { type: "chat", title: "Chat", plugin: "chat", parents: ["bot"] },
      ],
    });
    state = reduce(state, { type: "start-chat", parent: "bot:default" });
    return reduce(state, { type: "object", object: { ...bot(), sections: [{ id: "bot", title: "Bot" }] } });
  }

  test("the first message waits for the page's section", () => {
    const state = started();
    expect(state.object?.id).toBe("bot:default");
    expect(state.input).toBeUndefined();
    expect(state.creating?.mainFirst).toBe(true);
  });

  test("a main chat in the section opens that chat and starts no new one", () => {
    const state = reduce(started(), {
      type: "section",
      objectId: "bot:default",
      sectionId: "bot",
      content: { markdown: "", data: { mainChat: "chat:C-7" } },
    });
    expect(state.object?.id).toBe("chat:C-7");
    expect(state.objectRequest?.id).toBe("chat:C-7");
    expect(state.creating).toBeUndefined();
    expect(state.input).toBeUndefined();
  });

  test("no main chat in the section starts the new chat's first message", () => {
    const state = reduce(started(), {
      type: "section",
      objectId: "bot:default",
      sectionId: "bot",
      content: { markdown: "", data: { mainChat: null } },
    });
    expect(state.object?.id).toBe("bot:default");
    expect(state.creating).toBeUndefined();
    expect(state.input).toMatchObject({ kind: "note", action: "bot:chat", id: "bot:default" });
  });

  test("a section that fails to read starts the new chat's first message", () => {
    const state = reduce(started(), {
      type: "section-error",
      objectId: "bot:default",
      sectionId: "bot",
      message: "boom",
    });
    expect(state.input).toMatchObject({ kind: "note", action: "bot:chat" });
  });
});

class Silent implements TuiEventSource {
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

class Client implements TuiShellClient {
  readonly objectCalls: string[] = [];
  types(): Promise<{ readonly types: readonly [] }> {
    return Promise.resolve({ types: [] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(): Promise<ViewListPage> {
    return Promise.resolve({ rows: [] });
  }
  object(id: string): Promise<ViewObject> {
    this.objectCalls.push(id);
    return Promise.resolve(id === "bot:default" ? bot() : {
      id,
      type: id.slice(0, id.indexOf(":")),
      link: "",
      row: room(id),
      sections: [],
      actions: [],
    });
  }
  section(): Promise<ViewSectionContent> {
    return Promise.resolve({ markdown: "" });
  }
}

describe("the shell's start-chat option", () => {
  test("opens the default bot once the first lists arrive and puts the cursor in its input", async () => {
    const client = new Client();
    const view = new View();
    const shell = startShell({
      client,
      events: () => new Silent(),
      view,
      width: 120,
      height: 20,
      theme: "dark",
      clock: immediateClock,
      startChat: "bot:default",
    });
    try {
      await view.until(
        (state) => state.object?.id === "bot:default" && state.input?.kind === "note",
      );
      expect(client.objectCalls).toEqual(["bot:default"]);
      expect(shell.state.input).toMatchObject({
        kind: "note",
        action: "bot:chat",
        id: "bot:default",
        text: "",
      });
    } finally {
      shell.stop();
      await shell.done;
    }
  });
});
