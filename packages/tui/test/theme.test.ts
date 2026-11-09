import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { TextChunk } from "@opentui/core";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import {
  BUILTIN_THEMES,
  THEME_NAMES,
  TUI_TOKENS,
  chooseSelection,
  chooseTheme,
  resolveSelection,
  watchThemes,
  type ThemeHolder,
  resolvePalette,
  toRgba,
  tuiConfigPath,
} from "../src/theme.ts";
import { runTui } from "../src/app.ts";
import { markdownLines } from "../src/markdown.ts";
import { drawState } from "../src/view/index.ts";

function home(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-theme-"));
  if (config !== undefined) writeFileSync(tuiConfigPath(dir), config);
  return dir;
}

function stateOf(mode: "light" | "dark"): TuiState {
  let state = initialState({ width: 120, height: 24, theme: mode });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  state = reduce(state, {
    type: "pending",
    items: [
      {
        runId: "run-1",
        flow: "flow",
        step: "ask",
        prompt: "Approve?",
        choices: ["yes"],
        actions: [],
        object: "item:one",
      },
    ],
  });
  return state;
}

function chunksOf(state: TuiState, theme: string): TextChunk[] {
  const drawing = drawState(state, theme);
  return [drawing.header, drawing.list, drawing.footer, drawing.rule].flatMap((text) => [
    ...text.chunks,
  ]);
}

describe("the theme tokens", () => {
  test("each built-in theme has every token", () => {
    for (const [name, palette] of Object.entries(BUILTIN_THEMES)) {
      for (const token of TUI_TOKENS) {
        expect(typeof palette[token], `${name}.${token}`).toBe("string");
        expect(palette[token].length).toBeGreaterThan(0);
      }
      expect(Object.keys(palette).sort()).toEqual([...TUI_TOKENS].sort());
    }
  });

  test("light and dark carry the app's tokens", () => {
    expect(BUILTIN_THEMES.light).toMatchObject({
      accent: "#5b3fd0", run: "#1f6fd1", ok: "#1d7a4b", error: "#c3242c",
      weak: "#6a6a75", text: "#17171a", rule: "#e4e3e9", tint: "#f1eefc", code: "#f4f3f7",
    });
    expect(BUILTIN_THEMES.dark).toMatchObject({
      accent: "#a793ff", run: "#6aa9ff", ok: "#5fcf9a", error: "#ff7d82",
      weak: "#9696a3", text: "#ececf2", rule: "#292933", tint: "#1c1830", code: "#16161c",
    });
  });

  test("auto follows the terminal's theme mode, also when it switches", () => {
    expect(resolvePalette("auto", "light")).toBe(BUILTIN_THEMES.light);
    expect(resolvePalette("auto", "dark")).toBe(BUILTIN_THEMES.dark);
    let state = stateOf("light");
    const accent = (s: TuiState): string =>
      (chunksOf(s, "auto").find((c) => c.text === "❯")?.fg?.toInts() ?? []).join(",");
    const light = accent(state);
    state = reduce(state, { type: "theme", theme: "dark" });
    expect(accent(state)).not.toBe(light);
    expect(accent(state)).toBe(toRgba(BUILTIN_THEMES.dark.accent).toInts().join(","));
    // A fixed theme ignores the mode.
    expect(resolvePalette("light", "dark")).toBe(BUILTIN_THEMES.light);
  });

  test("the terminal theme draws ANSI indexes, not RGB", () => {
    const fgs = chunksOf(stateOf("dark"), "terminal").flatMap((c) => (c.fg ? [c.fg] : []));
    expect(fgs.length).toBeGreaterThan(0);
    for (const fg of fgs) expect(["indexed", "default"]).toContain(fg.intent);
    expect(fgs.some((fg) => fg.intent === "indexed")).toBe(true);
    const accent = toRgba(BUILTIN_THEMES.terminal.accent);
    expect(accent.intent).toBe("indexed");
    expect(accent.slot).toBe(5);
    expect(toRgba(BUILTIN_THEMES.terminal.run).slot).toBe(4);
    expect(toRgba(BUILTIN_THEMES.terminal.ok).slot).toBe(2);
    expect(toRgba(BUILTIN_THEMES.terminal.error).slot).toBe(1);
    expect(toRgba(BUILTIN_THEMES.terminal.weak).slot).toBe(8);
    expect(toRgba(BUILTIN_THEMES.terminal.text).intent).toBe("default");
    expect(toRgba(BUILTIN_THEMES.terminal.tint).intent).toBe("default");
    expect(toRgba(BUILTIN_THEMES.terminal.code).intent).toBe("default");
  });

  test("the selected row has the tint as its background", () => {
    const selected = chunksOf(stateOf("dark"), "dark").find((c) => c.bg !== undefined);
    expect(selected?.bg?.toInts().join(",")).toBe(toRgba(BUILTIN_THEMES.dark.tint).toInts().join(","));
  });
});

describe("rules, text and the selected row", () => {
  const ints = (colour: string): string => toRgba(colour).toInts().join(",");

  test("rules and the divider use the rule token", () => {
    const drawing = drawState(stateOf("light"), "light");
    expect(drawing.rule.chunks[0]?.fg?.toInts().join(",")).toBe(ints(BUILTIN_THEMES.light.rule));
  });

  test("plain markdown text and code use the text token", () => {
    const lines = markdownLines("plain prose\n\n```\ncode\n```", BUILTIN_THEMES.dark);
    const prose = lines.find((line) => line.text.includes("plain prose"));
    expect(prose?.chunks[0]?.fg?.toInts().join(",")).toBe(ints(BUILTIN_THEMES.dark.text));
  });

  test("an unselected list label uses the text token", () => {
    let state = stateOf("light");
    state = reduce(state, {
      type: "pending",
      items: [
        { runId: "run-1", flow: "flow", step: "ask", prompt: "A?", choices: ["yes"], actions: [], object: "item:one" },
        { runId: "run-2", flow: "flow", step: "ask", prompt: "B?", choices: ["yes"], actions: [], object: "item:two" },
      ],
    });
    const chunks = drawState(state, "light").list.chunks;
    const label = chunks.find((c) => c.text.includes("two"));
    expect(label?.fg?.toInts().join(",")).toBe(ints(BUILTIN_THEMES.light.text));
  });

  test("note text and unselected palette entries use the text token", () => {
    let state = initialState({ width: 120, height: 24, theme: "dark" });
    state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
    state = reduce(state, {
      type: "rows",
      tabId: "type:item",
      rows: [{ id: "item:one", title: "One", state: "new", waiting: false, running: false }],
    });
    state = reduce(state, { type: "key", key: "3" });
    state = reduce(state, { type: "key", key: "enter" });
    state = reduce(state, {
      type: "object",
      object: {
        id: "item:one",
        type: "item",
        link: "x",
        row: { id: "item:one", title: "One", state: "new", waiting: false, running: false },
        sections: [],
        actions: ["a", "b"].map((short) => ({
          plugin: "tuitest", action: short, on: "item", name: `tuitest:${short}`,
          noteRequired: false, confirm: false,
        })),
      },
    });
    const text = ints(BUILTIN_THEMES.dark.text);
    const note = drawState(
      { ...state, input: { kind: "note", action: "tuitest:a", id: "item:one", text: "hello", required: false, confirm: false } },
      "dark",
    ).overlay;
    expect(note?.chunks.find((c) => c.text.includes("hello"))?.fg?.toInts().join(",")).toBe(text);
    const palette = drawState({ ...state, input: { kind: "palette", query: "", cursor: 0 } }, "dark").overlay;
    expect(palette?.chunks.find((c) => c.text === "tuitest:b")?.fg?.toInts().join(",")).toBe(text);
  });

  test("the tint covers the whole selected row, padding included", () => {
    const state = stateOf("dark");
    const chunks = drawState(state, "dark").list.chunks;
    // Past the blank line and the title, the first row is the selected one.
    const row = chunks.slice(chunks.findIndex((c) => c.text === "❯")).filter((c) => c.text !== "\n");
    const tint = ints(BUILTIN_THEMES.dark.tint);
    expect(row.length).toBeGreaterThan(4);
    for (const piece of row) expect(piece.bg?.toInts().join(",")).toBe(tint);
    const width = row.reduce((sum, c) => sum + c.text.length, 0);
    expect(width).toBeGreaterThanOrEqual(20);
  });
});

describe("choosing the theme", () => {
  test("the default is auto", () => {
    expect(chooseTheme({ home: home() })).toBe("auto");
  });

  test("tui.json names the theme and --theme beats it", () => {
    const dir = home('{ "theme": "terminal" }');
    expect(chooseTheme({ home: dir })).toBe("terminal");
    expect(chooseTheme({ home: dir, flag: "light" })).toBe("light");
  });

  test("an unknown name is an error that lists the names", () => {
    expect(() => chooseTheme({ home: home(), flag: "neon" })).toThrow(
      `unknown theme "neon"; the themes are ${THEME_NAMES.join(", ")}`,
    );
    const dir = home('{ "theme": "neon" }');
    expect(() => chooseTheme({ home: dir })).toThrow(tuiConfigPath(dir));
  });

  test("a broken tui.json is an error naming the file, even with --theme", () => {
    for (const text of ["{ nope", "[]", '{ "theme": 3 }', '{ "colour": "dark" }']) {
      const dir = home(text);
      expect(() => chooseTheme({ home: dir, flag: "dark" })).toThrow(tuiConfigPath(dir));
    }
  });

  test("the app does not start on an unknown theme or a broken file", async () => {
    const names = THEME_NAMES.join(", ");
    await expect(runTui({ home: home(), theme: "neon", noStart: true })).rejects.toThrow(names);
    const dir = home("{ nope");
    await expect(runTui({ home: dir, noStart: true })).rejects.toThrow(tuiConfigPath(dir));
  });

  test("the schema lists the same names", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "tui.schema.json"), "utf8"));
    expect(schema.properties.theme.type).toBe("string");
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("colours live in the theme module", () => {
  test("no hex colour literal outside src/theme.ts", () => {
    const root = join(import.meta.dir, "..", "src");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && relative(root, path) !== "theme.ts") {
          if (/#[0-9a-fA-F]{3,8}\b/.test(readFileSync(path, "utf8"))) found.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });
});

describe("file themes", () => {
  function withThemes(files: Record<string, string>, config?: string): string {
    const dir = home(config);
    mkdirSync(join(dir, "themes"));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, "themes", `${name}.json`), text);
    }
    return dir;
  }

  test("a theme names only what it changes and extends dark by default", () => {
    const dir = withThemes({ mine: '{ "colors": { "accent": "#ff8800", "error": 9 } }' });
    const palette = resolveSelection(dir, "mine").palette;
    expect(palette).toEqual({ ...BUILTIN_THEMES.dark, accent: "#ff8800", error: "ansi:9" });
  });

  test("extends follows built-ins and other themes", () => {
    const dir = withThemes({
      a: '{ "extends": "light", "colors": { "text": "#000001" } }',
      b: '{ "extends": "a", "colors": { "weak": "#000002" } }',
      c: '{ "extends": "terminal" }',
    });
    expect(resolveSelection(dir, "b").palette).toEqual({
      ...BUILTIN_THEMES.light,
      text: "#000001",
      weak: "#000002",
    });
    expect(resolveSelection(dir, "c").palette).toEqual(BUILTIN_THEMES.terminal);
  });

  test("a cycle in extends names the file and the key", () => {
    const dir = withThemes({ a: '{ "extends": "b" }', b: '{ "extends": "a" }' });
    expect(() => resolveSelection(dir, "a")).toThrow(/b\.json: "extends" makes a cycle: a -> b -> a/);
  });

  test("an unknown token, a bad colour and an unknown extends name the file and the key", () => {
    const dir = withThemes({
      token: '{ "colors": { "glow": "#ffffff" } }',
      colour: '{ "colors": { "accent": "red" } }',
      index: '{ "colors": { "accent": 16 } }',
      parent: '{ "extends": "nope" }',
    });
    expect(() => resolveSelection(dir, "token")).toThrow(/token\.json: colors\.glow is not a token/);
    expect(() => resolveSelection(dir, "colour")).toThrow(/colour\.json: colors\.accent is "red"/);
    expect(() => resolveSelection(dir, "index")).toThrow(/index\.json: colors\.accent is 16/);
    expect(() => resolveSelection(dir, "parent")).toThrow(/parent\.json: "extends" names "nope"/);
  });

  test("a file with the name of a built-in is refused", () => {
    const dir = withThemes({ dark: "{}" }, '{ "theme": "dark" }');
    expect(() => chooseTheme({ home: dir })).toThrow(/dark\.json has the name of the built-in theme/);
    expect(() => chooseTheme({ home: dir, flag: "light" })).not.toThrow();
  });

  test("tui.json and --theme may name a file theme", () => {
    const dir = withThemes({ mine: "{}" }, '{ "theme": "mine" }');
    expect(chooseTheme({ home: dir })).toBe("mine");
    expect(() => chooseTheme({ home: dir, flag: "other" })).toThrow(/the themes are .*mine/);
  });

  test("a file theme is what the view draws", () => {
    const dir = withThemes({ mine: '{ "colors": { "accent": "#123456" } }' });
    const drawing = drawState(stateOf("dark"), resolveSelection(dir, "mine"));
    const colours = drawing.header.chunks.map((c) => c.fg?.toInts().slice(0, 3).join(","));
    expect(colours).toContain("18,52,86");
  });

  /** A watch the test drives: `fire` delivers a change the way the platform does. */
  function fakeWatch(): {
    watch: (directory: string, onChange: (filename: string | null) => void) => () => void;
    fire: (directory: string, filename: string) => void;
    open: () => number;
  } {
    const listeners = new Map<string, (filename: string | null) => void>();
    return {
      watch: (directory, onChange) => {
        listeners.set(directory, onChange);
        return () => listeners.delete(directory);
      },
      fire: (directory, filename) => listeners.get(directory)?.(filename),
      open: () => listeners.size,
    };
  }

  test("a change to the theme file or tui.json is applied; an invalid edit keeps the last good theme", () => {
    const dir = withThemes({ mine: '{ "colors": { "accent": "#111111" } }' }, '{ "theme": "mine" }');
    const holder: ThemeHolder = { current: chooseSelection({ home: dir }) };
    const changes: (string | undefined)[] = [];
    const fake = fakeWatch();
    const stop = watchThemes({
      home: dir,
      holder,
      watch: fake.watch,
      repeat: () => () => undefined,
      onChange: (problem) => changes.push(problem),
    });
    const file = join(dir, "themes", "mine.json");
    writeFileSync(file, '{ "colors": { "accent": "#222222" } }');
    fake.fire(join(dir, "themes"), "mine.json");
    expect(holder.current.palette?.accent).toBe("#222222");
    expect(changes).toEqual([undefined]);

    writeFileSync(file, '{ "colors": { "accent": "nope" } }');
    fake.fire(join(dir, "themes"), "mine.json");
    expect(holder.current.palette?.accent).toBe("#222222");
    expect(changes[1]).toContain("mine.json: colors.accent");

    writeFileSync(tuiConfigPath(dir), '{ "theme": "light" }');
    fake.fire(dir, "other.txt");
    expect(changes).toHaveLength(2);
    fake.fire(dir, "tui.json");
    expect(holder.current.name).toBe("light");
    expect(changes[2]).toBeUndefined();
    stop();
    expect(fake.open()).toBe(0);
  });

  test("the fallback timer picks up an edit the watch missed, and reports a problem once", () => {
    const dir = withThemes({ mine: '{ "colors": { "accent": "#111111" } }' }, '{ "theme": "mine" }');
    const holder: ThemeHolder = { current: chooseSelection({ home: dir }) };
    const changes: (string | undefined)[] = [];
    const fake = fakeWatch();
    let tick: () => void = () => undefined;
    let stopped = 0;
    const stop = watchThemes({
      home: dir,
      holder,
      watch: fake.watch,
      repeat: (_ms, callback) => {
        tick = callback;
        return () => {
          stopped += 1;
        };
      },
      onChange: (problem) => changes.push(problem),
    });
    tick();
    expect(changes).toEqual([]);
    const file = join(dir, "themes", "mine.json");
    writeFileSync(file, '{ "colors": { "accent": "#222222" } }');
    tick();
    expect(holder.current.palette?.accent).toBe("#222222");
    expect(changes).toEqual([undefined]);
    tick();
    expect(changes).toHaveLength(1);
    writeFileSync(file, '{ "colors": { "accent": "nope" } }');
    tick();
    tick();
    expect(changes).toHaveLength(2);
    expect(changes[1]).toContain("mine.json: colors.accent");
    stop();
    expect(stopped).toBe(1);
  });

  test("a themes directory that appears later is watched", () => {
    const dir = home('{ "theme": "mine" }');
    const holder: ThemeHolder = { current: { name: "dark" } };
    const fake = fakeWatch();
    const stop = watchThemes({ home: dir, holder, watch: fake.watch, repeat: () => () => undefined, onChange: () => undefined });
    expect(fake.open()).toBe(1);
    mkdirSync(join(dir, "themes"));
    writeFileSync(join(dir, "themes", "mine.json"), '{ "colors": { "accent": "#333333" } }');
    fake.fire(dir, "themes");
    expect(fake.open()).toBe(2);
    expect(holder.current.palette?.accent).toBe("#333333");
    stop();
  });

  test("the real directory watch reports an edit", async () => {
    const dir = withThemes({ mine: '{ "colors": { "accent": "#111111" } }' }, '{ "theme": "mine" }');
    const holder: ThemeHolder = { current: chooseSelection({ home: dir }) };
    const file = join(dir, "themes", "mine.json");
    const edit = (): void => writeFileSync(file, '{ "colors": { "accent": "#222222" } }');
    let seen: () => void = () => undefined;
    let editing: ReturnType<typeof setInterval> | undefined;
    const stop = watchThemes({
      home: dir,
      holder,
      // The fallback timer never reads. It only repeats the edit, because a
      // watch can miss an edit made as it starts; a later edit must still
      // arrive through the watch itself.
      repeat: () => {
        editing = setInterval(edit, 50);
        return () => clearInterval(editing);
      },
      onChange: () => {
        if (holder.current.palette?.accent === "#222222") seen();
      },
    });
    try {
      await new Promise<void>((resolve) => {
        seen = resolve;
        edit();
      });
    } finally {
      stop();
    }
  });
});

describe("the example themes", () => {
  test("both load", () => {
    const dir = home();
    mkdirSync(join(dir, "themes"));
    for (const name of ["high-contrast", "low-saturation"]) {
      const text = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "themes", `${name}.json`), "utf8");
      writeFileSync(join(dir, "themes", `${name}.json`), text);
      expect(resolveSelection(dir, name).palette).toBeDefined();
    }
  });
});
