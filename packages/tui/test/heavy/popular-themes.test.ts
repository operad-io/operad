import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState, reduce, type TuiState } from "../../src/state.ts";
import {
  BUILTIN_THEMES,
  THEME_NAMES,
  TUI_TOKENS,
  resolvePalette,
  resolveSelection,
  toRgba,
  type TuiPalette,
  type TuiToken,
} from "../../src/theme.ts";
import { SHIPPED_THEMES, THEME_FAMILIES, shippedThemeFile } from "../../src/themes.ts";
import { drawState } from "../../src/view/index.ts";

const PACKAGE = join(import.meta.dir, "..", "..");
const THEMES = join(PACKAGE, "themes");
const MANUAL = join(PACKAGE, "..", "..", "docs", "manual.md");

interface ThemeFile {
  readonly comment: string;
  readonly colors: Record<string, unknown>;
  readonly [key: string]: unknown;
}

function themeFile(name: string): ThemeFile {
  return JSON.parse(readFileSync(shippedThemeFile(name), "utf8")) as ThemeFile;
}

/** WCAG 2.x relative luminance of "#rrggbb". */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "operad-popular-"));
  mkdirSync(join(dir, "themes"));
  return dir;
}

function stateOf(mode: "light" | "dark"): TuiState {
  let state = initialState({ width: 120, height: 24, theme: mode });
  state = reduce(state, { type: "types", types: [{ type: "item", title: "Item" }] });
  return reduce(state, {
    type: "pending",
    items: [
      { runId: "run-1", flow: "flow", step: "ask", prompt: "Approve?", choices: ["yes"], actions: [], object: "item:one" },
    ],
  });
}

describe("shipped themes: the files", () => {
  test("themes/ holds exactly the listed themes, each with its licence text", () => {
    const files = readdirSync(THEMES).sort();
    const expected = [
      ...SHIPPED_THEMES.map((name) => `${name}.json`),
      "README.md",
      ...[...new Set(SHIPPED_THEMES.map((name) => themeFile(name).comment.match(/the text is in (LICENSE-[a-z-]+)/)?.[1] ?? ""))],
    ].sort();
    expect(files).toEqual(expected);
    for (const file of files.filter((name) => name.startsWith("LICENSE-"))) {
      expect(readFileSync(join(THEMES, file), "utf8")).toMatch(/Permission is hereby granted/);
    }
  });

  test("every file matches the theme schema and sets every token itself", () => {
    const schema = JSON.parse(readFileSync(join(PACKAGE, "theme.schema.json"), "utf8")) as {
      properties: { colors: { properties: Record<string, { oneOf: { pattern?: string }[] }> } };
    };
    const allowed = Object.keys(schema.properties);
    const colourSchema = schema.properties.colors.properties;
    for (const name of SHIPPED_THEMES) {
      const file = themeFile(name);
      for (const key of Object.keys(file)) expect(allowed, `${name}: ${key}`).toContain(key);
      expect(file["extends"], name).toBeUndefined();
      expect(Object.keys(file.colors).sort(), name).toEqual([...TUI_TOKENS].sort());
      for (const [token, value] of Object.entries(file.colors)) {
        const pattern = colourSchema[token]?.oneOf.find((rule) => rule.pattern !== undefined)?.pattern;
        expect(typeof value === "string" && new RegExp(pattern ?? "$^").test(value), `${name}.${token}`).toBe(true);
      }
    }
  });

  test("each file records its source URL and licence, and the README lists them", () => {
    const readme = readFileSync(join(THEMES, "README.md"), "utf8");
    for (const name of SHIPPED_THEMES) {
      const { comment } = themeFile(name);
      const url = comment.match(/Source: (https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/)?.[1];
      expect(url, name).toBeDefined();
      expect(comment, name).toMatch(/Licence: MIT, Copyright/);
      expect(readme, name).toContain(`\`${name}\``);
      expect(readme, name).toContain(url ?? "");
    }
  });

  test("every shipped theme resolves to a full palette equal to its file", () => {
    for (const name of SHIPPED_THEMES) {
      const palette = resolvePalette(name, "dark");
      expect(Object.keys(palette).sort(), name).toEqual([...TUI_TOKENS].sort());
      expect(palette, name).toEqual(themeFile(name).colors as unknown as TuiPalette);
      // A shipped theme is fixed: the terminal's mode does not change it.
      expect(resolvePalette(name, "light"), name).toBe(palette);
      // A code block and a selected row must not share a background.
      expect(palette.code, name).not.toBe(palette.tint);
    }
  });

  test("Rosé Pine's selected row is visible on its base", () => {
    for (const name of ["rose-pine-main", "rose-pine-dawn"]) {
      const palette = resolvePalette(name, "dark");
      expect(contrast(palette.tint, palette.background), name).toBeGreaterThan(1.1);
    }
  });

  test("a missing shipped file fails when its theme or family is chosen, not when the module is imported", () => {
    // A copy of the package in a temporary root mirroring the repository layout
    // (<root>/packages/tui), so the test never moves a shipped file: a killed
    // test cannot leave the worktree with a theme missing. The copy resolves
    // its dependencies through links to the real node_modules directories, both
    // the repository's and the package's (the install may hoist into either).
    const repository = join(PACKAGE, "..", "..");
    const root = mkdtempSync(join(tmpdir(), "operad-lazy-theme-"));
    const copy = join(root, "packages", "tui");
    const missing = join(copy, "themes", "rose-pine-main.json");
    try {
      mkdirSync(join(copy, "src"), { recursive: true });
      mkdirSync(join(copy, "themes"));
      // theme.ts imports ./themes.ts, whose shipped directory is ../themes.
      for (const file of ["theme.ts", "themes.ts"]) {
        copyFileSync(join(PACKAGE, "src", file), join(copy, "src", file));
      }
      for (const name of SHIPPED_THEMES) {
        if (name !== "rose-pine-main") {
          copyFileSync(shippedThemeFile(name), join(copy, "themes", `${name}.json`));
        }
      }
      for (const directory of [join(repository, "node_modules"), join(PACKAGE, "node_modules")]) {
        if (existsSync(directory)) {
          symlinkSync(directory, join(directory === join(PACKAGE, "node_modules") ? copy : root, "node_modules"), "dir");
        }
      }
      const module = JSON.stringify(join(copy, "src", "theme.ts"));
      // One child does the import and both choices: each extra Bun start costs
      // more than the test itself.
      const script = `
        const { resolveSelection } = await import(${module});
        for (const name of ["rose-pine-main", "rose-pine"]) {
          try {
            resolveSelection(${JSON.stringify(home())}, name);
            console.error("chose " + name);
            process.exit(4);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes(${JSON.stringify(missing)})) {
              console.error(name + ": " + message);
              process.exit(5);
            }
          }
        }
      `;
      const checked = spawnSync(process.execPath, ["-e", script], { cwd: copy, encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("families", () => {
  test("every family names an existing light and dark theme, and is not a theme itself", () => {
    expect(Object.keys(THEME_FAMILIES).sort()).toEqual(
      ["catppuccin", "github", "kanagawa", "one", "rose-pine", "solarized", "tokyo-night"],
    );
    for (const [family, members] of Object.entries(THEME_FAMILIES)) {
      expect(SHIPPED_THEMES, `${family} light`).toContain(members.light);
      expect(SHIPPED_THEMES, `${family} dark`).toContain(members.dark);
      expect(SHIPPED_THEMES, family).not.toContain(family);
      expect(THEME_NAMES, family).toContain(family);
      // The light member has a light background and the dark member a dark one.
      expect(luminance(resolvePalette(members.light, "dark").background), family).toBeGreaterThan(0.18);
      expect(luminance(resolvePalette(members.dark, "light").background), family).toBeLessThan(0.18);
    }
    expect(THEME_FAMILIES["kanagawa"]).toEqual({ light: "kanagawa-lotus", dark: "kanagawa-wave" });
    expect(THEME_FAMILIES["catppuccin"]).toEqual({ light: "catppuccin-latte", dark: "catppuccin-mocha" });
  });

  test("a family follows the theme mode like auto, also when it switches", () => {
    const accent = (state: TuiState, name: string): string => {
      const drawing = drawState(state, name);
      const chunks = [drawing.header, drawing.list, drawing.footer, drawing.rule].flatMap((text) => [...text.chunks]);
      return (chunks.find((chunk) => chunk.text === "❯")?.fg?.toInts() ?? []).join(",");
    };
    for (const [family, members] of Object.entries(THEME_FAMILIES)) {
      expect(resolvePalette(family, "light"), family).toBe(resolvePalette(members.light, "light"));
      expect(resolvePalette(family, "dark"), family).toBe(resolvePalette(members.dark, "dark"));
      let state = stateOf("light");
      const light = accent(state, family);
      expect(light, family).toBe(toRgba(resolvePalette(members.light, "light").accent).toInts().join(","));
      state = reduce(state, { type: "theme", theme: "dark" });
      expect(accent(state, family), family).toBe(toRgba(resolvePalette(members.dark, "dark").accent).toInts().join(","));
    }
  });

  test("choosing a family or a shipped theme needs no file", () => {
    const dir = home();
    expect(resolveSelection(dir, "catppuccin")).toEqual({ name: "catppuccin" });
    expect(resolveSelection(dir, "dracula")).toEqual({ name: "dracula" });
    expect(() => resolveSelection(dir, "gruvbox")).toThrow(/unknown theme "gruvbox"/);
  });
});

describe("contrast", () => {
  // The terminal's default background is unknown, so each palette's own base
  // colour (the `background` token) stands in for it.
  const NEEDED: readonly (readonly [TuiToken, number])[] = [
    ["text", 4.5],
    ["weak", 3],
    ["accent", 3],
    ["run", 3],
    ["ok", 3],
    ["error", 3],
    ["add", 3],
    ["remove", 3],
  ];

  test("text reaches 4.5:1 and weak, accent, run, ok, error, add and remove 3:1 on the base colour", () => {
    for (const name of SHIPPED_THEMES) {
      const palette = resolvePalette(name, "dark");
      for (const [token, needed] of NEEDED) {
        const value = contrast(palette[token], palette.background);
        expect(value, `${name}.${token} ${palette[token]} on ${palette.background}`).toBeGreaterThanOrEqual(needed);
      }
    }
  });

  test("a colour below its need is adjusted in the file, and the file's comment says so", () => {
    // A palette colour that misses is never changed silently: the comment names
    // the token, the upstream colour and the new one.
    for (const name of SHIPPED_THEMES) {
      const { comment } = themeFile(name);
      const adjusted = [...comment.matchAll(/(?:^|[ ;])(text|weak|accent|run|ok|error|add|remove) (#[0-9a-f]{6}) \([^)]*\)+ -> (#[0-9a-f]{6})/g)];
      expect(comment, name).toMatch(/No colour adjusted\.|Adjusted for contrast/);
      if (comment.includes("No colour adjusted.")) expect(adjusted, name).toEqual([]);
      for (const [, token, from, to] of adjusted) {
        expect(themeFile(name).colors[token as string], `${name}.${token}`).toBe(to);
        expect(from, `${name}.${token}`).not.toBe(to);
      }
    }
  });

  test("the measure itself: black on white is 21:1 and equal colours are 1:1", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

describe("user files and shipped names", () => {
  test("a user theme named like a shipped theme or a family is refused", () => {
    for (const name of ["dracula", "kanagawa-wave", "catppuccin", "tokyo-night"]) {
      const dir = home();
      writeFileSync(join(dir, "themes", `${name}.json`), '{ "colors": { "accent": "#ff8800" } }');
      expect(() => resolveSelection(dir, name), name).toThrow(
        new RegExp(`${name}\\.json has the name of the built-in theme "${name}"`),
      );
    }
  });

  test("a user theme can extend a shipped theme, and the comment key is accepted", () => {
    const dir = home();
    writeFileSync(
      join(dir, "themes", "mine.json"),
      '{ "comment": "nord with my accent", "extends": "nord", "colors": { "accent": "#ff8800" } }',
    );
    expect(resolveSelection(dir, "mine").palette).toEqual({ ...resolvePalette("nord", "dark"), accent: "#ff8800" });
    writeFileSync(join(dir, "themes", "bad.json"), '{ "extends": "catppuccin" }');
    expect(() => resolveSelection(dir, "bad")).toThrow(/"extends" names "catppuccin"/);
    writeFileSync(join(dir, "themes", "loud.json"), '{ "comment": 5 }');
    expect(() => resolveSelection(dir, "loud")).toThrow(/"comment" must be a string/);
  });

  test("the operad light and dark themes are unchanged", () => {
    expect(resolvePalette("light", "dark")).toBe(BUILTIN_THEMES.light);
    expect(resolvePalette("dark", "light")).toBe(BUILTIN_THEMES.dark);
  });
});

describe("the manual", () => {
  test("lists every shipped theme and every family", () => {
    const manual = readFileSync(MANUAL, "utf8");
    for (const name of [...SHIPPED_THEMES, ...Object.keys(THEME_FAMILIES)]) {
      expect(manual, name).toContain(`\`${name}\``);
    }
  });
});
