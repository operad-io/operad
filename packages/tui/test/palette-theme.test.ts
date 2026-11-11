import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { paletteEntries } from "../src/actions.ts";
import { runTui } from "../src/app.ts";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import {
  BUILTIN_THEMES,
  chooseSelection,
  installedThemes,
  resolvePalette,
  saveThemeChoice,
  toRgba,
  tuiConfigPath,
} from "../src/theme.ts";

function home(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-palette-theme-"));
  mkdirSync(join(dir, "themes"));
  writeFileSync(join(dir, "themes", "mine.json"), '{ "colors": { "accent": "#ff8800" } }');
  if (config !== undefined) writeFileSync(tuiConfigPath(dir), config);
  return dir;
}

const ints = (colour: string): string => toRgba(colour).toInts().join(",");

describe("the theme command: list and keys", () => {
  test("the palette has a theme command; the list is the built-in, shipped and own themes", () => {
    const dir = home();
    const names = installedThemes(dir);
    expect(names).toContain("dark");
    expect(names).toContain("dracula");
    expect(names).toContain("mine");
    const state = initialState({ themeNames: names, themeCurrent: "dark" });
    const open = reduce(state, { type: "key", key: ":", text: ":" });
    expect(paletteEntries(open).some((entry) => entry.name === "theme" && entry.group === "tui")).toBe(true);
  });

  function themeList(current: string): TuiState {
    let state = initialState({ themeNames: ["auto", "dark", "nord"], themeCurrent: current });
    for (const key of [":", "t", "h", "e", "m", "e"]) state = reduce(state, { type: "key", key, text: key });
    return reduce(state, { type: "key", key: "enter" });
  }

  test("it opens on the theme in use and previews it", () => {
    const state = themeList("dark");
    expect(state.input).toEqual({ kind: "themes", cursor: 1 });
    expect(state.themePreview).toBe("dark");
  });

  test("a theme file removed while the list is open keeps the cursor on a theme", () => {
    const state = reduce(reduce(themeList("nord"), { type: "key", key: "down" }), {
      type: "theme-names",
      names: ["auto", "dark"],
      current: "dark",
    });
    expect(state.input).toEqual({ kind: "themes", cursor: 1 });
  });

  test("moving previews the theme under the cursor, and stops at the ends", () => {
    let state = reduce(themeList("dark"), { type: "key", key: "down" });
    expect(state.themePreview).toBe("nord");
    state = reduce(state, { type: "key", key: "down" });
    expect(state.themePreview).toBe("nord");
    state = reduce(state, { type: "key", key: "up" });
    state = reduce(state, { type: "key", key: "up" });
    state = reduce(state, { type: "key", key: "up" });
    expect(state.themePreview).toBe("auto");
  });

  test("escape closes the list and ends the preview, asking for nothing", () => {
    const state = reduce(reduce(themeList("dark"), { type: "key", key: "down" }), { type: "key", key: "escape" });
    expect(state.input).toBeUndefined();
    expect(state.themePreview).toBeUndefined();
    expect(state.themeRequest).toBeUndefined();
    expect(state.themeCurrent).toBe("dark");
  });

  test("enter asks to keep the theme under the cursor", () => {
    const state = reduce(reduce(themeList("dark"), { type: "key", key: "down" }), { type: "key", key: "enter" });
    expect(state.input).toBeUndefined();
    expect(state.themePreview).toBeUndefined();
    expect(state.themeRequest).toBe("nord");
    expect(state.themeCurrent).toBe("nord");
  });
});

describe("saving the choice", () => {
  test("it writes tui.json, keeps the other keys and the next start reads it", () => {
    const dir = home('{ "$schema": "x", "theme": "dark" }');
    saveThemeChoice(dir, "mine");
    expect(JSON.parse(readFileSync(tuiConfigPath(dir), "utf8"))).toEqual({ $schema: "x", theme: "mine" });
    expect(chooseSelection({ home: dir }).name).toBe("mine");
  });

  test("it creates the file, and refuses an unknown theme or a broken file without writing", () => {
    const dir = home();
    saveThemeChoice(dir, "nord");
    expect(JSON.parse(readFileSync(tuiConfigPath(dir), "utf8"))).toEqual({ theme: "nord" });
    expect(() => saveThemeChoice(dir, "neon")).toThrow("unknown theme");
    expect(JSON.parse(readFileSync(tuiConfigPath(dir), "utf8"))).toEqual({ theme: "nord" });
    const broken = home("{ nope");
    expect(() => saveThemeChoice(broken, "nord")).toThrow("not valid JSON");
    expect(readFileSync(tuiConfigPath(broken), "utf8")).toBe("{ nope");
  });
});

describe("the theme command in the running app", () => {
  /** Runs the app on a test renderer; `steps` get the keys and a way to read the accent colour. */
  async function session(
    dir: string,
    steps: (tools: {
      press: (...keys: string[]) => Promise<void>;
      accent: () => Promise<string>;
    }) => Promise<void>,
  ): Promise<void> {
    const setup = await createTestRenderer({ width: 100, height: 20 });
    const abort = new AbortController();
    const running = runTui({
      home: dir,
      url: "http://127.0.0.1:1",
      token: "t",
      signal: abort.signal,
      hooks: { renderer: async () => setup.renderer },
    });
    try {
      const press = async (...keys: string[]): Promise<void> => {
        for (const key of keys) {
          setup.mockInput.pressKey(key);
        }
        await setup.renderOnce();
      };
      // The header's first tab is the active one, drawn in the accent colour.
      const accent = async (): Promise<string> => {
        await setup.renderOnce();
        const spans = setup.captureSpans().lines[0]?.spans ?? [];
        const span = spans.find((one) => one.text.includes("Pending"));
        if (span === undefined) throw new Error("no header tab");
        return span.fg.toInts().join(",");
      };
      // The app draws once it owns the screen; its keys work from then on.
      do await setup.renderOnce();
      while (!setup.captureCharFrame().includes("operad"));
      await steps({ press, accent });
    } finally {
      abort.abort();
      await running;
      await setup.dispose();
    }
  }

  const open = ["t", "h", "e", "m", "e", "RETURN"];

  test("moving the selection changes the drawn colours; escape puts them back", async () => {
    const dir = home('{ "theme": "dark" }');
    await session(dir, async ({ press, accent }) => {
      const before = await accent();
      expect(before).toBe(ints(BUILTIN_THEMES.dark.accent));
      await press(":", ...open);
      // Down from dark is the next name in the list.
      const next = installedThemes(dir)[installedThemes(dir).indexOf("dark") + 1];
      if (next === undefined) throw new Error("no theme after dark");
      await press("ARROW_DOWN");
      const previewed = await accent();
      expect(previewed).not.toBe(before);
      expect(previewed).toBe(ints(resolvePalette(next, "dark").accent));
      // A lone escape is held back by the key parser until it knows no sequence follows.
      await press("ESCAPE");
      while ((await accent()) !== before) await new Promise((resolve) => setImmediate(resolve));
      expect(await accent()).toBe(before);
    });
    // Nothing was written.
    expect(readFileSync(tuiConfigPath(dir), "utf8")).toBe('{ "theme": "dark" }');
  });

  test("enter keeps the theme, writes tui.json, and a new start uses it", async () => {
    const dir = home('{ "theme": "dark" }');
    const names = installedThemes(dir);
    const target = "mine";
    await session(dir, async ({ press, accent }) => {
      await press(":", ...open);
      const steps = names.indexOf(target) - names.indexOf("dark");
      for (let at = 0; at < steps; at += 1) await press("ARROW_DOWN");
      await press("RETURN");
      expect(await accent()).toBe(ints("#ff8800"));
    });
    expect(JSON.parse(readFileSync(tuiConfigPath(dir), "utf8"))).toEqual({ theme: "mine" });
    await session(dir, async ({ accent }) => {
      expect(await accent()).toBe(ints("#ff8800"));
    });
  });
});
