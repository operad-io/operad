import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { TextChunk } from "@opentui/core";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import {
  BUILTIN_THEMES,
  THEME_NAMES,
  TUI_TOKENS,
  chooseTheme,
  resolvePalette,
  toRgba,
  tuiConfigPath,
} from "../src/theme.ts";
import { runTui } from "../src/app.ts";
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
    expect(schema.properties.theme.enum).toEqual([...THEME_NAMES]);
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
