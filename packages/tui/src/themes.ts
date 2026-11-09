/**
 * The themes shipped with operad and the families that pair a light theme with
 * a dark one. The colours are in `themes/<name>.json` (same format as the
 * person's own theme files); this module only names them. This is the one place
 * that declares a family.
 */

import { join } from "node:path";

/** A family: a name that follows the terminal's light or dark mode. */
export interface ThemeFamily {
  readonly light: string;
  readonly dark: string;
}

/** The shipped themes, one file each in `themes/`. */
export const SHIPPED_THEMES: readonly string[] = [
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dracula",
  "nord",
  "solarized-light",
  "solarized-dark",
  "tokyo-night-day",
  "tokyo-night-night",
  "one-light",
  "one-dark",
  "rose-pine-dawn",
  "rose-pine-main",
  "github-light",
  "github-dark",
  "kanagawa-lotus",
  "kanagawa-wave",
  "kanagawa-dragon",
];

/**
 * `theme: "<family>"` shows the family's light member in a light terminal and
 * its dark member in a dark one, and switches live like `auto`. A family name is
 * never also a theme name, so every shipped theme can still be chosen on its own.
 */
export const THEME_FAMILIES: Readonly<Record<string, ThemeFamily>> = {
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  solarized: { light: "solarized-light", dark: "solarized-dark" },
  "tokyo-night": { light: "tokyo-night-day", dark: "tokyo-night-night" },
  one: { light: "one-light", dark: "one-dark" },
  "rose-pine": { light: "rose-pine-dawn", dark: "rose-pine-main" },
  github: { light: "github-light", dark: "github-dark" },
  kanagawa: { light: "kanagawa-lotus", dark: "kanagawa-wave" },
};

/** The directory of the shipped theme files. */
export const SHIPPED_DIRECTORY = join(import.meta.dir, "..", "themes");

/** The file of one shipped theme. */
export function shippedThemeFile(name: string): string {
  return join(SHIPPED_DIRECTORY, `${name}.json`);
}
