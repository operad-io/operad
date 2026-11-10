import { describe, expect, test } from "bun:test";
import type { PendingItem, RunningItem, ViewListPage } from "@operad-io/engine";
import {
  TuiError,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiSetInput,
  type TuiSetting,
  type TuiShell,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { paletteEntries, settingScopes, settingValue } from "../src/actions.ts";
import { initialState, reduce } from "../src/state.ts";
import { drawState, overlayBox } from "../src/view/index.ts";
import { immediateClock } from "./support.ts";

class Quiet implements TuiEventSource {
  private release: () => void = () => undefined;
  private readonly ended = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  stop(): void {
    this.release();
  }
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return { next: () => this.ended.then(() => ({ done: true as const, value: undefined })) };
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

const EMPTY: ViewListPage = { rows: [] } as unknown as ViewListPage;

/** A server that keeps settings in memory and refuses what the real one refuses. */
class FakeServer implements TuiShellClient {
  readonly sets: TuiSetInput[] = [];
  readonly settings_: TuiSetting[] = [
    {
      name: "demo.limit",
      scope: "global",
      value: 3,
      default: 2,
      description: "How many at once.",
      type: "integer",
      editable: true,
      confirm: false,
    },
    {
      name: "demo.mode",
      scope: "global",
      value: "a",
      default: "a",
      description: "Which way to work.",
      type: "string",
      enum: ["a", "b", "c"],
      editable: true,
      confirm: false,
    },
    {
      name: "demo.auto",
      scope: "global",
      value: false,
      default: false,
      description: "Run without asking.",
      type: "boolean",
      editable: true,
      confirm: true,
    },
    {
      name: "demo.fixed",
      scope: "global",
      value: "x",
      default: "x",
      description: "Set by the plugin.",
      type: "string",
      editable: false,
      confirm: false,
    },
  ];

  types(): Promise<{ readonly types: readonly [] }> {
    return Promise.resolve({ types: [] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(_t?: string, _c?: string, _s?: AbortSignal, _f?: string, level?: { readonly parent?: string | undefined }): Promise<ViewListPage> {
    if (level?.parent !== undefined) return Promise.resolve({ rows: [] });
    return Promise.resolve(EMPTY);
  }
  settings(scope?: string): Promise<readonly TuiSetting[]> {
    return Promise.resolve(this.settings_.filter((s) => scope === undefined || s.scope === scope));
  }
  setSetting(input: TuiSetInput): Promise<TuiSetting> {
    this.sets.push(input);
    const found = this.settings_.findIndex((s) => s.name === input.name);
    const setting = this.settings_[found];
    if (setting === undefined) return Promise.reject(new TuiError(`no setting "${input.name}"`, { status: 404 }));
    if (!setting.editable) {
      return Promise.reject(new TuiError(`setting "${input.name}" cannot be changed here`, { status: 409 }));
    }
    if (input.name === "demo.limit" && (typeof input.value !== "number" || input.value < 1)) {
      return Promise.reject(new TuiError("demo.limit: must be an integer of at least 1", { status: 422 }));
    }
    if (setting.confirm && input.confirmed !== true) {
      return Promise.reject(new TuiError(`setting "${input.name}" needs confirmation`, { status: 409 }));
    }
    const changed = { ...setting, value: input.value };
    this.settings_[found] = changed;
    return Promise.resolve(changed);
  }
}

interface Setup {
  readonly server: FakeServer;
  readonly view: View;
  readonly shell: TuiShell;
  type(text: string): void;
}

function setup(): Setup {
  const server = new FakeServer();
  const view = new View();
  const shell = startShell({
    client: server,
    events: () => new Quiet(),
    view,
    width: 100,
    height: 30,
    theme: "dark",
    clock: immediateClock,
  });
  return {
    server,
    view,
    shell,
    type(text) {
      for (const char of text) shell.key({ name: char === " " ? "space" : char, sequence: char });
    },
  };
}

/** Opens the palette on the settings and waits for them to arrive. */
async function palette(s: Setup, query: string): Promise<void> {
  s.shell.key({ name: ":", sequence: ":" });
  await s.view.until((state) => state.settings.length > 0);
  s.type(query);
}

function entries(s: Setup): string[] {
  return paletteEntries(s.shell.state)
    .filter((entry) => entry.group === "settings")
    .map((entry) => entry.name);
}

describe("settings in the palette", () => {
  test("every setting is listed, and search reads the name and the description", async () => {
    const s = setup();
    await palette(s, "");
    expect(entries(s)).toEqual(["demo.limit", "demo.mode", "demo.auto", "demo.fixed"]);
    s.type("run without");
    expect(entries(s)).toEqual(["demo.auto"]);
    s.shell.stop();
    const t = setup();
    await palette(t, "mode");
    expect(entries(t)[0]).toBe("demo.mode");
    t.shell.stop();
  });

  test("opening one shows its value, default and description; an enum changes through a choice list", async () => {
    const s = setup();
    await palette(s, "demo.mode");
    s.shell.key({ name: "enter" });
    const input = s.view.last?.input;
    expect(input?.kind).toBe("setting");
    if (input?.kind !== "setting") throw new Error("not a setting");
    expect(input.setting.value).toBe("a");
    expect(input.setting.default).toBe("a");
    expect(input.setting.description).toBe("Which way to work.");
    expect(input.field?.kind).toBe("pick");
    expect(input.field?.options.map((o) => o.label)).toEqual(["a", "b", "c"]);
    s.shell.key({ name: "down" });
    s.shell.key({ name: "enter" });
    await s.view.until((state) => state.settings.find((x) => x.name === "demo.mode")?.value === "b");
    expect(s.server.sets).toEqual([{ name: "demo.mode", scope: "global", value: "b", signal: s.server.sets[0]?.signal }]);
    expect(s.shell.state.input).toBeUndefined();
    s.shell.stop();
  });

  test("a number is typed and sent as a number; the server decides", async () => {
    const s = setup();
    await palette(s, "demo.limit");
    s.shell.key({ name: "enter" });
    // The prompt starts on the current value.
    s.shell.key({ name: "backspace" });
    s.type("7");
    s.shell.key({ name: "enter" });
    await s.view.until((state) => state.settings.find((x) => x.name === "demo.limit")?.value === 7);
    expect(s.server.sets[0]?.value).toBe(7);
    s.shell.stop();
  });

  test("the server's refusal shows as a notice with its reason, and nothing changes", async () => {
    const s = setup();
    await palette(s, "demo.limit");
    s.shell.key({ name: "enter" });
    s.shell.key({ name: "backspace" });
    s.type("0");
    s.shell.key({ name: "enter" });
    await s.view.until((state) => state.notice !== undefined);
    expect(s.view.last?.notice).toBe("demo.limit: must be an integer of at least 1");
    expect(s.view.last?.acting).toBe(false);
    expect(s.view.last?.settings.find((x) => x.name === "demo.limit")?.value).toBe(3);
    s.shell.stop();
  });

  test("a confirm setting asks first; any key but y cancels, y sends it confirmed", async () => {
    const s = setup();
    await palette(s, "demo.auto");
    s.shell.key({ name: "enter" });
    const input = s.view.last?.input;
    if (input?.kind !== "setting") throw new Error("not a setting");
    expect(input.field?.options.map((o) => o.label)).toEqual(["yes", "no"]);
    // The list starts on the current value, no.
    s.shell.key({ name: "up" });
    s.shell.key({ name: "enter" });
    expect(s.view.last?.input?.kind).toBe("setting-confirm");
    expect(s.server.sets).toEqual([]);
    s.shell.key({ name: "n", sequence: "n" });
    expect(s.view.last?.input).toBeUndefined();
    expect(s.server.sets).toEqual([]);

    await palette(s, "demo.auto");
    s.shell.key({ name: "enter" });
    s.shell.key({ name: "up" });
    s.shell.key({ name: "enter" });
    s.shell.key({ name: "y", sequence: "y" });
    await s.view.until((state) => state.settings.find((x) => x.name === "demo.auto")?.value === true);
    expect(s.server.sets).toHaveLength(1);
    expect(s.server.sets[0]?.confirmed).toBe(true);
    expect(s.server.sets[0]?.value).toBe(true);
    s.shell.stop();
  });

  test("a setting that cannot change opens read-only and sends nothing", async () => {
    const s = setup();
    await palette(s, "demo.fixed");
    s.shell.key({ name: "enter" });
    const input = s.view.last?.input;
    if (input?.kind !== "setting") throw new Error("not a setting");
    expect(input.field).toBeUndefined();
    expect(input.setting.value).toBe("x");
    s.type("zz");
    s.shell.key({ name: "enter" });
    expect(s.view.last?.input).toBeUndefined();
    expect(s.server.sets).toEqual([]);
    s.shell.stop();
  });

  test("the open setting is drawn with its value, default and description", async () => {
    const s = setup();
    await palette(s, "demo.limit");
    s.shell.key({ name: "enter" });
    const state = s.shell.state;
    const text = drawState(state, "dark").overlay?.chunks.map((c) => c.text).join("") ?? "";
    expect(text).toContain("demo.limit");
    expect(text).toContain("How many at once.");
    expect(text).toContain("value: 3");
    expect(text).toContain("default: 2");
    s.shell.stop();
  });
});

describe("typed setting text", () => {
  test("a string setting keeps text that reads as JSON; other types parse it", () => {
    expect(settingValue("42", "string")).toBe("42");
    expect(settingValue("true", "string")).toBe("true");
    expect(settingValue("42", "integer")).toBe(42);
    expect(settingValue("42")).toBe(42);
    expect(settingValue("hello", "integer")).toBe("hello");
  });

  test("a text prompt's box has a line for the typed text and one for the hint", async () => {
    const s = setup();
    await palette(s, "demo.limit");
    s.shell.key({ name: "enter" });
    const state = s.shell.state;
    const drawn = drawState(state, "dark").overlay?.chunks.map((c) => c.text).join("") ?? "";
    expect(drawn).toContain("enter sets");
    expect(overlayBox(state)?.height ?? 0).toBeGreaterThanOrEqual(drawn.split("\n").length + 4);
    s.shell.stop();
  });
});

describe("the scopes the palette lists", () => {
  function open(type: string, id: string): TuiState {
    let state = initialState({ width: 100 });
    state = reduce(state, { type: "types", types: [{ type, title: type }] });
    const row = { id, title: "x", state: "new", waiting: false, running: false };
    state = reduce(state, { type: "rows", tabId: `plugin:${type}`, rows: [row] });
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, { type: "key", key: "enter" });
    return reduce(state, {
      type: "object",
      object: { id, type, link: "x", row, sections: [], actions: [] },
    });
  }

  test("no object lists global only; a task names its repository; a repository's own page names itself", () => {
    expect(settingScopes(initialState())).toEqual(["global"]);
    expect(settingScopes(open("task", "task:operad/T-0085"))).toEqual(["global", "operad"]);
    expect(settingScopes(open("repo", "repo:operad"))).toEqual(["global", "operad"]);
  });
});
