/**
 * The TUI's colours. Every colour the TUI draws is a token of one `TuiPalette`;
 * this module is the only place that names a colour value. A colour is a string:
 * a hex triplet, `ansi:<0-15>` (the terminal's own colour), or `default-fg` /
 * `default-bg` (the terminal's default foreground / background).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RGBA } from "@opentui/core";
import { watchDirectory } from "@operad-io/engine/platform";

/** The theme mode a terminal reports. */
export type TuiMode = "light" | "dark";

/** The colour tokens every theme defines. */
export interface TuiPalette {
  /** Ordinary text. */
  readonly text: string;
  /** Secondary text, hints, rules' labels. */
  readonly weak: string;
  /** Rules and borders. */
  readonly rule: string;
  /** What needs you. */
  readonly accent: string;
  /** In progress. */
  readonly run: string;
  /** Success. */
  readonly ok: string;
  readonly error: string;
  /** An added diff line. */
  readonly add: string;
  /** A removed diff line. */
  readonly remove: string;
  /** The selection's background. */
  readonly tint: string;
  /** A code block's background. */
  readonly code: string;
  /** The fill of an overlay box (palette, note, confirmation, key list). */
  readonly background: string;
}

export type TuiToken = keyof TuiPalette;

/** Every token name, in the order the docs list them. */
export const TUI_TOKENS: readonly TuiToken[] = [
  "text",
  "weak",
  "rule",
  "accent",
  "run",
  "ok",
  "error",
  "add",
  "remove",
  "tint",
  "code",
  "background",
];

const LIGHT: TuiPalette = {
  text: "#17171a",
  weak: "#6a6a75",
  rule: "#e4e3e9",
  accent: "#5b3fd0",
  run: "#1f6fd1",
  ok: "#1d7a4b",
  error: "#c3242c",
  add: "#1a7f37",
  remove: "#cf222e",
  tint: "#f1eefc",
  code: "#f4f3f7",
  background: "#ffffff",
};

const DARK: TuiPalette = {
  text: "#ececf2",
  weak: "#9696a3",
  rule: "#292933",
  accent: "#a793ff",
  run: "#6aa9ff",
  ok: "#5fcf9a",
  error: "#ff7d82",
  add: "#7ee787",
  remove: "#ff7b72",
  tint: "#1c1830",
  code: "#16161c",
  background: "#0e0e12",
};

/** The terminal's own 16 colours: its scheme decides the look. */
const TERMINAL: TuiPalette = {
  text: "default-fg",
  weak: "ansi:8",
  rule: "ansi:8",
  accent: "ansi:5",
  run: "ansi:4",
  ok: "ansi:2",
  error: "ansi:1",
  add: "ansi:2",
  remove: "ansi:1",
  tint: "default-bg",
  code: "default-bg",
  background: "default-bg",
};

/** Light and dark palettes, for code that has a mode and no theme name. */
export const TUI_PALETTE: Readonly<Record<TuiMode, TuiPalette>> = {
  light: LIGHT,
  dark: DARK,
};

/** The built-in themes that are a palette of their own. */
export const BUILTIN_THEMES: Readonly<Record<"light" | "dark" | "terminal", TuiPalette>> = {
  light: LIGHT,
  dark: DARK,
  terminal: TERMINAL,
};

/** The theme names a person can choose. `auto` follows the terminal. */
export const THEME_NAMES: readonly string[] = ["auto", "light", "dark", "terminal"];

export const DEFAULT_THEME = "auto";

/** The palette a theme name shows in a terminal whose mode is `mode`. */
export function resolvePalette(name: string, mode: TuiMode): TuiPalette {
  if (name === "auto") return TUI_PALETTE[mode];
  if (name === "light" || name === "dark" || name === "terminal") return BUILTIN_THEMES[name];
  throw new Error(unknownTheme(name));
}

function unknownTheme(name: string): string {
  return `unknown theme "${name}"; the themes are ${THEME_NAMES.join(", ")}`;
}

/** The drawing colour of a token value. */
export function toRgba(colour: string): RGBA {
  if (colour === "default-fg") return RGBA.defaultForeground();
  if (colour === "default-bg") return RGBA.defaultBackground();
  const index = /^ansi:(\d{1,2})$/.exec(colour);
  if (index !== null) return RGBA.fromIndex(Number(index[1]));
  return RGBA.fromHex(colour);
}

/** The file that holds the theme choice. */
export function tuiConfigPath(home: string): string {
  return join(home, "tui.json");
}

/** The directory of the person's own theme files. */
export function themesDirectory(home: string): string {
  return join(home, "themes");
}

/** A theme as the view draws it: a built-in by name, or a file theme's own palette. */
export interface ThemeSelection {
  readonly name: string;
  /** Set for a file theme; a built-in is resolved from its name and the mode. */
  readonly palette?: TuiPalette | undefined;
}

const FILE_THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

function isBuiltin(name: string): boolean {
  return THEME_NAMES.includes(name);
}

function themeFile(home: string, name: string): string {
  return join(themesDirectory(home), `${name}.json`);
}

function fileThemeNames(home: string): string[] {
  try {
    return readdirSync(themesDirectory(home))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((name) => FILE_THEME_NAME.test(name) && !isBuiltin(name))
      .sort();
  } catch {
    return [];
  }
}

function unknownThemeIn(home: string, name: string): string {
  const names = [...THEME_NAMES, ...fileThemeNames(home)];
  return `unknown theme "${name}"; the themes are ${names.join(", ")}`;
}

function colourValue(file: string, token: string, value: unknown): string {
  if (typeof value === "string" && HEX_COLOUR.test(value)) return value.toLowerCase();
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15) {
    return `ansi:${value}`;
  }
  throw new Error(
    `${file}: colors.${token} is ${JSON.stringify(value)}, not a colour; use "#rrggbb" or an ANSI index from 0 to 15`,
  );
}

/** Reads one theme file and the themes it extends into a full palette. */
function loadFileTheme(home: string, name: string, chain: readonly string[]): TuiPalette {
  const file = themeFile(home, name);
  if (!existsSync(file)) {
    const by = themeFile(home, chain[chain.length - 1] ?? name);
    throw new Error(
      `${by}: "extends" names "${name}", which is not a theme; the themes are ${[...THEME_NAMES, ...fileThemeNames(home)].join(", ")}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not valid JSON: ${reason}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} must be a JSON object like {"colors": {"accent": "#ff8800"}}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "extends" && key !== "colors" && key !== "$schema") {
      throw new Error(`${file}: unknown key "${key}"; only "extends" and "colors" are allowed`);
    }
  }
  const parent = record["extends"] ?? "dark";
  if (typeof parent !== "string") throw new Error(`${file}: "extends" must be a string`);
  const colors = record["colors"] ?? {};
  if (typeof colors !== "object" || colors === null || Array.isArray(colors)) {
    throw new Error(`${file}: "colors" must be an object of token to colour`);
  }
  const changes: Partial<Record<TuiToken, string>> = {};
  for (const [token, colour] of Object.entries(colors)) {
    if (!(TUI_TOKENS as readonly string[]).includes(token)) {
      throw new Error(
        `${file}: colors.${token} is not a token; the tokens are ${TUI_TOKENS.join(", ")}`,
      );
    }
    changes[token as TuiToken] = colourValue(file, token, colour);
  }
  let base: TuiPalette;
  if (parent === "light" || parent === "dark" || parent === "terminal") {
    if (existsSync(themeFile(home, parent))) throw new Error(clash(home, parent));
    base = BUILTIN_THEMES[parent];
  } else if (!FILE_THEME_NAME.test(parent) || parent === "auto") {
    throw new Error(
      `${file}: "extends" names "${parent}"; use light, dark, terminal or another theme file`,
    );
  } else {
    const chained = [...chain, name];
    if (chained.includes(parent)) {
      throw new Error(`${file}: "extends" makes a cycle: ${[...chained, parent].join(" -> ")}`);
    }
    base = loadFileTheme(home, parent, chained);
  }
  return { ...base, ...changes };
}

function clash(home: string, name: string): string {
  return `${themeFile(home, name)} has the name of the built-in theme "${name}"; rename the file`;
}

/** The theme a name stands for; it throws an error naming the file and the key. */
export function resolveSelection(home: string, name: string): ThemeSelection {
  if (isBuiltin(name)) {
    if (existsSync(themeFile(home, name))) throw new Error(clash(home, name));
    return { name };
  }
  if (!FILE_THEME_NAME.test(name) || !existsSync(themeFile(home, name))) {
    throw new Error(unknownThemeIn(home, name));
  }
  return { name, palette: loadFileTheme(home, name, []) };
}

/**
 * The theme for this session: `flag` beats `tui.json`, which beats `auto`.
 * It throws an error naming the problem when the name is unknown, a theme file
 * is invalid or the config cannot be read, so the TUI never starts on a
 * half-read config.
 */
export function chooseSelection(options: {
  readonly home: string;
  readonly flag?: string | undefined;
}): ThemeSelection {
  const file = tuiConfigPath(options.home);
  // The file is read even when the flag wins, so a broken file is not hidden.
  const fromFile = readThemeFile(file);
  const name = options.flag ?? fromFile ?? DEFAULT_THEME;
  try {
    return resolveSelection(options.home, name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!reason.startsWith("unknown theme")) throw error;
    const where = options.flag === undefined ? ` in ${file}` : " given with --theme";
    throw new Error(`${reason}${where}`);
  }
}

/** The theme name for this session; see `chooseSelection`. */
export function chooseTheme(options: {
  readonly home: string;
  readonly flag?: string | undefined;
}): string {
  return chooseSelection(options).name;
}

/** The theme in force, kept up to date by `watchThemes`. */
export interface ThemeHolder {
  current: ThemeSelection;
}

/**
 * Watches `tui.json` and the themes directory. After every change it chooses the
 * theme again: a good result replaces `holder.current` and calls `onChange()`; a
 * bad one keeps the last good theme and calls `onChange` with the reason.
 * Returns the stop function.
 */
export function watchThemes(options: {
  readonly home: string;
  readonly flag?: string | undefined;
  readonly holder: ThemeHolder;
  readonly onChange: (problem?: string) => void;
  readonly watch?: typeof watchDirectory | undefined;
}): () => void {
  const watch = options.watch ?? watchDirectory;
  const themes = themesDirectory(options.home);
  let stopThemes: (() => void) | undefined;
  let stopped = false;
  const reload = (): void => {
    if (stopped) return;
    // The themes directory may appear after the TUI started.
    if (stopThemes === undefined && existsSync(themes)) stopThemes = watch(themes, reload);
    try {
      options.holder.current = chooseSelection({ home: options.home, flag: options.flag });
    } catch (error) {
      options.onChange(error instanceof Error ? error.message : String(error));
      return;
    }
    options.onChange();
  };
  const stopHome = watch(options.home, (filename) => {
    if (filename === null || filename === "tui.json" || filename === "themes") reload();
  });
  if (existsSync(themes)) stopThemes = watch(themes, reload);
  return () => {
    stopped = true;
    stopHome();
    stopThemes?.();
  };
}

function readThemeFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not valid JSON: ${reason}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} must be a JSON object like {"theme": "dark"}`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "theme" && key !== "$schema") {
      throw new Error(`${file} has an unknown key "${key}"; only "theme" is allowed`);
    }
  }
  const theme = (value as { readonly theme?: unknown }).theme;
  if (theme === undefined) return undefined;
  if (typeof theme !== "string") throw new Error(`${file}: "theme" must be a string`);
  return theme;
}
