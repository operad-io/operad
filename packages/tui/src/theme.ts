/**
 * The TUI's colours. Every colour the TUI draws is a token of one `TuiPalette`;
 * this module is the only place that names a colour value. A colour is a string:
 * a hex triplet, `ansi:<0-15>` (the terminal's own colour), or `default-fg` /
 * `default-bg` (the terminal's default foreground / background).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RGBA } from "@opentui/core";

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

/**
 * The theme name for this session: `flag` beats `tui.json`, which beats `auto`.
 * It throws an error naming the problem when the name is unknown or the file
 * cannot be read, so the TUI never starts on a half-read config.
 */
export function chooseTheme(options: {
  readonly home: string;
  readonly flag?: string | undefined;
}): string {
  const file = tuiConfigPath(options.home);
  // The file is read even when the flag wins, so a broken file is not hidden.
  const fromFile = readThemeFile(file);
  const name = options.flag ?? fromFile ?? DEFAULT_THEME;
  if (!THEME_NAMES.includes(name)) {
    const where = options.flag === undefined ? ` in ${file}` : " given with --theme";
    throw new Error(`${unknownTheme(name)}${where}`);
  }
  return name;
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
