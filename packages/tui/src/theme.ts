/**
 * The TUI's colours. Every colour the TUI draws is a token of one `TuiPalette`;
 * this module is the only place that names a colour value. A colour is a string:
 * a hex triplet, `ansi:<0-15>` (the terminal's own colour), or `default-fg` /
 * `default-bg` (the terminal's default foreground / background).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RGBA } from "@opentui/core";
import { watchDirectory } from "@operad-io/engine/platform";
import { SHIPPED_THEMES, THEME_FAMILIES, shippedThemeFile } from "./themes.ts";

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

/**
 * The theme names a person can choose. `auto` follows the terminal, and so does
 * a family; the shipped themes are fixed.
 */
export const THEME_NAMES: readonly string[] = [
  "auto",
  "light",
  "dark",
  "terminal",
  ...Object.keys(THEME_FAMILIES),
  ...SHIPPED_THEMES,
];

export const DEFAULT_THEME = "auto";

/** The palette a theme name shows in a terminal whose mode is `mode`. */
export function resolvePalette(name: string, mode: TuiMode): TuiPalette {
  if (name === "auto") return TUI_PALETTE[mode];
  if (name === "light" || name === "dark" || name === "terminal") return BUILTIN_THEMES[name];
  const shipped = shippedPalette(name);
  if (shipped !== undefined) return shipped;
  const family = THEME_FAMILIES[name];
  if (family !== undefined) return resolvePalette(family[mode], mode);
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

/** The themes a person can choose: the built-in and shipped ones, then the files in `<home>/themes`. */
export function installedThemes(home: string): readonly string[] {
  return [...THEME_NAMES, ...fileThemeNames(home)];
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

/**
 * The shipped themes already read, by name. A file is read the first time its
 * theme is chosen, not when this module is imported: a missing or broken file
 * fails that choice, not every TUI start.
 */
const SHIPPED_PALETTES = new Map<string, TuiPalette>();

/** One shipped palette, read on first use and checked like any theme file. */
function shippedPalette(name: string): TuiPalette | undefined {
  if (!SHIPPED_THEMES.includes(name)) return undefined;
  const cached = SHIPPED_PALETTES.get(name);
  if (cached !== undefined) return cached;
  const file = shippedThemeFile(name);
  const { parent, changes } = parseThemeFile(file);
  if (parent !== "dark") throw new Error(`${file}: a shipped theme extends dark, not "${parent}"`);
  const palette = { ...DARK, ...changes };
  SHIPPED_PALETTES.set(name, palette);
  return palette;
}

/** What a theme file says: the theme it extends and the tokens it changes. */
function parseThemeFile(file: string): {
  readonly parent: string;
  readonly changes: Partial<Record<TuiToken, string>>;
} {
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
    if (key !== "extends" && key !== "colors" && key !== "$schema" && key !== "comment") {
      throw new Error(`${file}: unknown key "${key}"; only "extends", "colors" and "comment" are allowed`);
    }
  }
  if (record["comment"] !== undefined && typeof record["comment"] !== "string") {
    throw new Error(`${file}: "comment" must be a string`);
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
  return { parent, changes };
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
  const { parent, changes } = parseThemeFile(file);
  let base: TuiPalette;
  const shipped = shippedPalette(parent);
  if (parent === "light" || parent === "dark" || parent === "terminal") {
    if (existsSync(themeFile(home, parent))) throw new Error(clash(home, parent));
    base = BUILTIN_THEMES[parent];
  } else if (shipped !== undefined) {
    if (existsSync(themeFile(home, parent))) throw new Error(clash(home, parent));
    base = shipped;
  } else if (!FILE_THEME_NAME.test(parent) || isBuiltin(parent)) {
    throw new Error(
      `${file}: "extends" names "${parent}"; use light, dark, terminal, a shipped theme or another theme file`,
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
    // A shipped theme is checked when it is chosen; a family checks both of its
    // members, whichever one the terminal's mode later picks.
    const family = THEME_FAMILIES[name];
    if (family !== undefined) {
      shippedPalette(family.light);
      shippedPalette(family.dark);
    } else {
      shippedPalette(name);
    }
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
  /** A theme shown only while a person looks at it; it wins over `current` until cleared. */
  preview?: ThemeSelection | undefined;
}

/**
 * Writes the theme choice to `tui.json`, keeping every other key in the file.
 * It throws, and writes nothing, when the name is not a theme or the file
 * cannot be read as it is.
 */
export function saveThemeChoice(home: string, name: string): void {
  resolveSelection(home, name);
  const file = tuiConfigPath(home);
  // Reading checks the file first, so a broken one is never overwritten.
  readThemeFile(file);
  const existing: Record<string, unknown> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  mkdirSync(home, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...existing, theme: name }, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * Watches `tui.json` and the themes directory. After every change the watch
 * reports, and on a fallback timer (an edit can slip past the watch), it chooses
 * the theme again. A watch event always calls `onChange`; a timer tick calls it
 * only when the theme or the problem changed. A result: a good result replaces `holder.current` and calls `onChange()`; a
 * bad one keeps the last good theme and calls `onChange` with the reason.
 * Returns the stop function.
 */
export function watchThemes(options: {
  readonly home: string;
  readonly flag?: string | undefined | (() => string | undefined);
  readonly holder: ThemeHolder;
  readonly onChange: (problem?: string) => void;
  readonly watch?: typeof watchDirectory | undefined;
  /** The fallback timer; a test injects it. Defaults to a real interval. */
  readonly repeat?: ((ms: number, callback: () => void) => () => void) | undefined;
  readonly pollMs?: number | undefined;
}): () => void {
  const watch = options.watch ?? watchDirectory;
  const themes = themesDirectory(options.home);
  let stopThemes: (() => void) | undefined;
  let stopped = false;
  let lastProblem: string | undefined;
  // A directory watch is the fast path, not a promise: an edit made as the
  // watch starts can produce no event. The timer re-reads and reports only a
  // change in the theme or in the problem.
  const refresh = (always: boolean): void => {
    if (stopped) return;
    // The themes directory may appear after the TUI started.
    if (stopThemes === undefined && existsSync(themes)) stopThemes = watch(themes, reload);
    let next: ThemeSelection;
    try {
      const flag = typeof options.flag === "function" ? options.flag() : options.flag;
      next = chooseSelection({ home: options.home, flag });
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      const changed = problem !== lastProblem;
      lastProblem = problem;
      if (always || changed) options.onChange(problem);
      return;
    }
    const changed = lastProblem !== undefined || JSON.stringify(next) !== JSON.stringify(options.holder.current);
    lastProblem = undefined;
    options.holder.current = next;
    if (always || changed) options.onChange();
  };
  const reload = (): void => refresh(true);
  const stopPoll = (options.repeat ?? repeatEvery)(options.pollMs ?? 500, () => refresh(false));
  const stopHome = watch(options.home, (filename) => {
    if (filename === null || filename === "tui.json" || filename === "themes") reload();
  });
  if (existsSync(themes)) stopThemes = watch(themes, reload);
  return () => {
    stopped = true;
    stopPoll();
    stopHome();
    stopThemes?.();
  };
}

function repeatEvery(ms: number, callback: () => void): () => void {
  const timer = setInterval(callback, ms);
  // The fallback must not keep the process alive by itself.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
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
