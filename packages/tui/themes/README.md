# Shipped themes

Theme files in the format of `~/.operad/themes` (schema: `../theme.schema.json`),
built in to the TUI. A file of the same name in the operad home is refused. The
`comment` field of each file repeats the source, the licence, which upstream
colour each token takes and every adjustment made.

| Theme | Palette | Source | Licence | Adjusted |
|---|---|---|---|---|
| `catppuccin-latte` | Catppuccin Latte | https://github.com/catppuccin/palette | MIT, Copyright (c) 2021 Catppuccin (`LICENSE-catppuccin`) | yes |
| `catppuccin-frappe` | Catppuccin Frappe | https://github.com/catppuccin/palette | MIT, Copyright (c) 2021 Catppuccin (`LICENSE-catppuccin`) | no |
| `catppuccin-macchiato` | Catppuccin Macchiato | https://github.com/catppuccin/palette | MIT, Copyright (c) 2021 Catppuccin (`LICENSE-catppuccin`) | no |
| `catppuccin-mocha` | Catppuccin Mocha | https://github.com/catppuccin/palette | MIT, Copyright (c) 2021 Catppuccin (`LICENSE-catppuccin`) | no |
| `dracula` | Dracula | https://github.com/dracula/dracula-theme | MIT, Copyright (c) 2023 Dracula Theme (`LICENSE-dracula`) | no |
| `nord` | Nord | https://github.com/nordtheme/nord | MIT, Copyright (c) 2016-present Sven Greb (`LICENSE-nord`) | yes |
| `solarized-light` | Solarized Light | https://github.com/altercation/solarized | MIT, Copyright (c) 2011 Ethan Schoonover (`LICENSE-solarized`) | yes |
| `solarized-dark` | Solarized Dark | https://github.com/altercation/solarized | MIT, Copyright (c) 2011 Ethan Schoonover (`LICENSE-solarized`) | yes |
| `tokyo-night-day` | Tokyo Night Day | https://github.com/tokyo-night/tokyo-night-vscode-theme | MIT, Copyright (c) 2018-present Enkia (`LICENSE-tokyo-night`) | no |
| `tokyo-night-night` | Tokyo Night | https://github.com/tokyo-night/tokyo-night-vscode-theme | MIT, Copyright (c) 2018-present Enkia (`LICENSE-tokyo-night`) | yes |
| `one-light` | One Light | https://github.com/atom/one-light-syntax | MIT, Copyright (c) 2016 GitHub Inc. (`LICENSE-one`) | yes |
| `one-dark` | One Dark | https://github.com/atom/one-dark-syntax | MIT, Copyright (c) 2016 GitHub Inc. (`LICENSE-one`) | no |
| `rose-pine-dawn` | Rosé Pine Dawn | https://github.com/rose-pine/palette | MIT, Copyright (c) mvllow (`LICENSE-rose-pine`) | no |
| `rose-pine-main` | Rosé Pine | https://github.com/rose-pine/palette | MIT, Copyright (c) mvllow (`LICENSE-rose-pine`) | no |
| `github-light` | GitHub Light | https://github.com/primer/primitives | MIT, Copyright (c) 2018 GitHub Inc. (`LICENSE-github`) | no |
| `github-dark` | GitHub Dark | https://github.com/primer/primitives | MIT, Copyright (c) 2018 GitHub Inc. (`LICENSE-github`) | no |
| `kanagawa-lotus` | Kanagawa Lotus | https://github.com/rebelot/kanagawa.nvim | MIT, Copyright (c) 2021 Tommaso Laurenzi (`LICENSE-kanagawa`) | yes |
| `kanagawa-wave` | Kanagawa Wave | https://github.com/rebelot/kanagawa.nvim | MIT, Copyright (c) 2021 Tommaso Laurenzi (`LICENSE-kanagawa`) | no |
| `kanagawa-dragon` | Kanagawa Dragon | https://github.com/rebelot/kanagawa.nvim | MIT, Copyright (c) 2021 Tommaso Laurenzi (`LICENSE-kanagawa`) | no |

Each palette's licence text is bundled here as `LICENSE-<source>`, exactly as its
repository ships it. The `one-*` themes share `LICENSE-one` because
`atom/one-dark-syntax` and `atom/one-light-syntax` carry the same text.

## How a palette maps to the tokens

By role, as each project's own editor theme uses its colours: `accent` is the
purple or mauve, `run` the blue (cyan where the palette has no blue: Dracula;
foam in Rosé Pine), `ok` the green (pine in Rosé Pine), `error` the red,
`cancelled` that red darkened for a cancelled child's bar segment, `add`
and `remove` the green and red of its diffs, `tint` its selection or highlight
background, `code` a second background (or the base itself where the palette
names only one) and `background` the palette's own base colour, which is the
colour the contrast check measures against (the terminal's own background is
unknown).

## Cross-check with the iOS app

The app's palettes (`radian-ios OperadApp/Theme/Palettes.swift`) are a
cross-check, not the source. Where a role differs, the file's `comment` says
why: Catppuccin Latte's `tint` is surface0 (PmenuSel), while the app's mantle is
the popup's base; Rosé Pine's `tint` is the editor's Visual blend and its `code`
the surface panel; and Kanagawa and Tokyo Night follow upstream `bg_visual` and
`list.activeSelectionBackground`, where the app's values are stale. The app also
adjusts every colour to 4.5:1, so its other values can differ where this project
needs only the token's stated ratio.

## Contrast

`test/heavy/popular-themes.test.ts` computes the WCAG contrast of each token against
`background`: `text` must reach 4.5:1; `weak`, `accent`, `run`, `ok`, `error`,
`add` and `remove` 3:1. `cancelled` is a dark red by design, so it is checked
apart from `error` and `weak` rather than against a text ratio. A colour that missed is lightened (dark palettes) or
darkened (light palettes) in whole-percent steps of HSL lightness until it
passes, and the file's `comment` says which token moved from which upstream colour
to which. Nothing else is changed. Upstream colours that pass are used as they
are, so a value can differ from the operad iPhone app's, which adjusts every
colour to 4.5:1.

## Names and families

A family follows the terminal's light or dark mode like `auto`. A family name is
never also a theme name, so every theme can still be chosen on its own: the
dark Tokyo Night is `tokyo-night-night` and the main Rosé Pine is
`rose-pine-main`. `tokyo-night-day` is the light variant that upstream calls
Tokyo Night Light. Families are declared in `../src/themes.ts`.

## Left out

Gruvbox is not shipped: `morhetz/gruvbox` has no licence file in its tree (its
README and `package.json` say MIT, but there is no licence text or copyright
line to bundle). It can be added when upstream adds one.
