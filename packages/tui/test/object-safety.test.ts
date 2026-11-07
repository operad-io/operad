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
  drawState,
  initialState,
  markdownLineCount,
  reduce,
  sectionLayout,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { layoutStats } from "../src/layout.ts";
import { sanitize } from "../src/sanitize.ts";
import { textWidth, wrapText } from "../src/wrap.ts";

/** Every control character a terminal could act on, except \n and \t. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function drawnText(state: TuiState): string {
  const drawing = drawState(state);
  return [drawing.header, drawing.rule, drawing.list, drawing.right, drawing.footer, ...(drawing.overlay === undefined ? [] : [drawing.overlay])]
    .flatMap((styled) => styled.chunks.map((chunk) => chunk.text))
    .join("");
}

class Events implements TuiEventSource {
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

const EVIL = "\x1b]52;c;AAAA\x07 \x1b[2J \x9b31m bell\x07 cr\r end";

class EvilClient implements TuiShellClient {
  types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    return Promise.resolve({ types: [{ type: "item", title: "Item\x1b[2J" }] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(): Promise<ViewListPage> {
    return Promise.resolve({
      rows: [
        {
          id: "one",
          title: `T${EVIL}`,
          state: "new\x1b[31m",
          note: `N${EVIL}`,
          waiting: false,
          running: false,
        },
        {
          id: "two",
          title: "Broken",
          state: "error",
          waiting: false,
          running: false,
          error: `E${EVIL}`,
        },
      ],
    });
  }
  object(id: string): Promise<ViewObject> {
    const row: ViewRow = {
      id,
      title: `T${EVIL}`,
      state: "new",
      note: `N${EVIL}`,
      waiting: false,
      running: false,
    };
    return Promise.resolve({
      id,
      type: "item",
      link: "operad://objects/item%3Aone",
      row,
      sections: [
        { id: "info", title: `Info${EVIL}` },
        { id: "bad", title: "Bad" },
      ],
      actions: [],
      unavailable: `U${EVIL}`,
    });
  }
  section(_id: string, section: string): Promise<ViewSectionContent> {
    if (section === "bad") return Promise.reject(new Error(`boom${EVIL}`));
    return Promise.resolve({
      markdown: [
        "a log line \x1b[31mfake red\x1b[0m here",
        `osc ${EVIL}`,
        "```",
        "\x1b[2Jcode line\x1b[0m",
        "```",
      ].join("\n"),
    });
  }
}

describe("server text never reaches the terminal as a control", () => {
  test("a log line, a title, a note and every error are drawn without control bytes", async () => {
    const view = new View();
    const shell = startShell({
      client: new EvilClient(),
      events: () => new Events(),
      view,
      width: 120,
      height: 24,
      theme: "dark",
    });
    try {
      await view.until((state) => state.tabs.find((tab) => tab.id === "type:item")?.list.loaded === true);
      shell.key({ name: "3" });
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.loaded === true);
      expect(drawnText(shell.state)).not.toMatch(CONTROL);

      shell.key({ name: "]" });
      await view.until((state) => state.object?.sections[1]?.error !== undefined);
      const text = drawnText(shell.state);
      expect(text).not.toMatch(CONTROL);
      expect(text).toContain("boom");

      // The list's own error row and the footer's status too.
      shell.key({ name: "escape" });
      expect(drawnText(shell.state)).toContain("two");
      expect(drawnText(shell.state)).not.toMatch(CONTROL);
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("a literal colour code in a log line is text, not a colour", async () => {
    const view = new View();
    const shell = startShell({
      client: new EvilClient(),
      events: () => new Events(),
      view,
      width: 120,
      height: 24,
      theme: "dark",
    });
    try {
      await view.until((state) => state.tabs.find((tab) => tab.id === "type:item")?.list.loaded === true);
      shell.key({ name: "3" });
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.sections[0]?.loaded === true);
      const chunks = drawState(shell.state).right.chunks;
      const fake = chunks.find((chunk) => chunk.text.includes("fake red"));
      expect(fake?.text).toContain("�[31mfake red");
      expect(fake?.fg).toBeUndefined();
    } finally {
      shell.stop();
      await shell.done;
    }
  });

  test("the cleaning keeps a newline and a tab and replaces the rest", () => {
    expect(sanitize("a\nb\tc")).toBe("a\nb\tc");
    expect(sanitize("a\x1bb\x07c\rd\x9be\x7ff\x00g")).toBe(
      "a�b�c�d�e�f�g",
    );
  });
});

function openedWith(markdown: string, width = 120, height = 24): TuiState {
  let state = reduce(initialState({ width, height }), {
    type: "types",
    types: [{ type: "item", title: "Item" }],
  });
  state = reduce(state, {
    type: "page",
    tabId: "type:item",
    replace: true,
    page: {
      rows: [{ id: "one", title: "One", state: "new", waiting: false, running: false }],
    },
  });
  state = reduce(state, { type: "key", key: "3" });
  state = reduce(state, { type: "key", key: "enter" });
  state = reduce(state, {
    type: "object",
    object: {
      id: "one",
      type: "item",
      link: "",
      row: { id: "one", title: "One", state: "new", waiting: false, running: false },
      sections: [{ id: "info", title: "Info" }],
      actions: [],
    },
    version: state.objectVersion,
  });
  return reduce(state, {
    type: "section",
    objectId: "one",
    sectionId: "info",
    content: { markdown },
    version: 0,
  });
}

describe("a large section is laid out once", () => {
  test("keys and renders after the first do not wrap the text again", () => {
    const text = Array.from({ length: 4000 }, (_, index) => `line ${index} ${"word ".repeat(20)}`).join("\n\n");
    let state = openedWith(text);
    drawState(state);
    const before = layoutStats.computed;
    for (let index = 0; index < 40; index += 1) {
      state = reduce(state, { type: "key", key: "pagedown" });
      drawState(state);
    }
    state = reduce(state, { type: "key", key: "G", shift: true });
    drawState(state);
    expect(layoutStats.computed).toBe(before);

    // A resize needs one new layout, and then it is kept again.
    state = reduce(state, { type: "resize", width: 100, height: 24 });
    drawState(state);
    drawState(state);
    expect(layoutStats.computed).toBe(before + 1);
  });
});

describe("wrapping is by display width", () => {
  test("CJK and emoji take two columns, combining marks none", () => {
    expect(textWidth("ab")).toBe(2);
    expect(textWidth("你好")).toBe(4);
    expect(textWidth("😀")).toBe(2);
    expect(textWidth("é")).toBe(1);
    expect(wrapText("你好世界你好", 4)).toEqual(["你好", "世界", "你好"]);
    expect(wrapText("a😀b😀c", 3)).toEqual(["a😀", "b😀", "c"]);
    expect(wrapText("ééé", 2)).toEqual(["éé", "é"]);
    // A glyph wider than the row still takes a row of its own.
    expect(wrapText("你", 1)).toEqual(["你"]);
  });

  test("the reducer counts, and the view draws, rows no wider than the pane", () => {
    const text = "你好世界".repeat(30);
    const state = openedWith(text, 120, 24);
    const section = state.object?.sections[0];
    if (section === undefined) throw new Error("no section");
    const layout = sectionLayout(state, section);
    expect(layout.length).toBe(markdownLineCount(text, 120 - 39 - 1));
    for (const line of layout) {
      expect(textWidth(line.text)).toBeLessThanOrEqual(120 - 39 - 1);
    }
    expect(layout.length).toBeGreaterThan(1);
  });
});
