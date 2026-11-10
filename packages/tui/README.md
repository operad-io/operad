# @operad-io/tui

The terminal client for operad's `/v1` interface. It never opens the store and
never loads a plugin. The manual's `operad tui` section is the reference for
keys, flags and states.

## Themes

Colours are tokens of a `TuiPalette` (`src/theme.ts`, the only file that names a
colour value): `text`, `weak`, `rule`, `accent`, `run`, `ok`, `error`,
`cancelled`, `add`, `remove`, `tint`, `code`, `background`. The built-in themes are `auto` (the default; `light` or
`dark` by the terminal's theme mode, live), `light`, `dark` (the operad app's
tokens) and `terminal` (the terminal's own 16 ANSI colours).

Popular palettes (Catppuccin, Dracula, Nord, Solarized, Tokyo Night, One,
Rosé Pine, GitHub, Kanagawa) ship as theme files in `themes/`; `themes/README.md`
has their sources, licences and contrast adjustments, and `src/themes.ts` declares
the families (`catppuccin`, `kanagawa`, ...) that follow the terminal's mode.

Choose one in `~/.operad/tui.json` (schema: `tui.schema.json`):

```json
{ "theme": "dark", "layout": "tree" }
```
`layout` is `tree` (children nested under the first sibling in their `after`) or
`list` (one flat list); `t` switches it on an object page and saves the choice.

`operad tui --theme <name>` overrides the file for one session. An unknown name,
or a `tui.json` that cannot be read, is an error and the TUI does not start.

The `:` palette has a `theme` command. It lists the installed themes (the built-in and
shipped ones, then the files in `~/.operad/themes`); moving the selection shows each
one live, Enter keeps the one under the cursor and writes it to `tui.json` (other keys
in the file stay), and Esc puts back the theme that was in use. A choice made there
beats `--theme` for the rest of the session.

## Hand tests (the lead runs these after a merge)

Use a scratch `OPERAD_HOME` with the `dev` plugin and some objects in it.

1. **Live row.** Run `operad tui`. In another terminal change an object (an
   action, or a new object). Its row updates within about a second; the list
   keeps its cursor.
2. **Live section.** Open an object with a live section (dot on its tab) and
   leave it at the bottom. Cause new output: the section grows and follows.
   Scroll up: it stops following.
3. **Pending and Running.** Start a flow that waits for you: it appears in
   Pending with no key press, and leaves it once answered.
4. **Server lost.** Stop the `serve` (`operad serve stop`). Within a few seconds
   the footer shows `no server at <url>: is `operad serve` running?`, the lists
   stay, dimmed. Start `operad serve` again: the footer clears and the lists
   come back without a key press.
5. **Rotated token.** Run `operad http token rotate` while the TUI is open. After
   the next change or `r` the footer says `the token was rotated: run the TUI
   again or pass --token`, and nothing is retried.
6. **Empty states.** With no waiting items Pending says `nothing waits for you`;
   an object type with no objects says `no <type> yet`.
7. **Failed section.** Open an object whose section fails (stop its source or
   use the `hang` fixture section). The section shows its message and `r
   retries`; `r` asks again.
8. **Leaving.** Quit with `q`, then with Ctrl-C, then `kill -TERM <tui pid>`
   (from another terminal), then `kill -INT <tui pid>`: each time the shell
   prompt is back with the normal screen, a visible cursor and working echo, and
   the exit code is 0.
