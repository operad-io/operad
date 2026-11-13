---
description: The terminal client: themes, live updates, states and leaving.
---

# The terminal client

`operad tui` is the terminal client for the same `/v1` interface. With a fresh
`~/.operad` it needs nothing else: no config edit, no `operad serve` in another
terminal, no token. It never opens the store and never loads a plugin. It finds
or starts the server like this:

- `--url` and `--token` win over the home when they are given. With `--url`
  nothing is ever started.
- Without `--url`, the URL is `http://<address>:<port>` for the first entry of
  `http.listen` and `http.port` in `config.json`; with no `http` section it is
  `http://127.0.0.1:7480`.
- It asks that address for `/v1/types`. If a `serve` answers, it goes on.
- If nothing answers and no `serve` holds this home, it starts `operad serve`
  for this `OPERAD_HOME`, prints `starting operad serve (log: <path>)`, waits up
  to 15 seconds (probe time counts) for it to answer, and opens the screen. The `serve` runs with
  the same runtime and `operad` entry as the command you typed, with
  `$OPERAD_HOME` as its working directory, appends its output to
  `$OPERAD_HOME/serve.log`, and keeps running after you quit the TUI,
  because the hub keeps running flows. Stop it with `operad serve stop` (see
  "Stopping serve") or press Ctrl-C in a terminal where you ran
  `operad serve` yourself. If it exits at once or never answers, `operad tui`
  fails with one error that names `serve.log` and shows its last lines;
  `serve.log` can hold plugin output, so read the lines before you paste them.
  If another `operad tui` started the `serve` first, this one waits for that
  `serve` to answer within the same 15 seconds.
- If a `serve` already holds this home but nothing answers at the address
  (`http.enabled` is false, or `http.port`/`http.listen` differ), it starts
  nothing and says so, naming `http.enabled` and `http.port`.
- If something answers at the address but it is not operad, it fails naming the
  port.
- With `http.port` 0 or an empty `http.listen` it starts nothing and says to set
  `http.port` (or `http.listen`) or pass `--url`.
- With `"enabled": false` in `http` it starts nothing and names `http.enabled`.
- `--no-start` turns the start off: the screen opens as before and shows the
  failure in its footer.
- Without `--token`, the token is the one `operad pair` reads from
  `$OPERAD_HOME/secrets/http.json`. `operad pair --show-token` prints it.

| Input | Type | Default | Allowed values |
|---|---|---|---|
| `--url` | string | `http://<first http.listen address>:<http.port>`, which is `http://127.0.0.1:7480` with no `http` section | An `http` or `https` URL without credentials, a query or a fragment. |
| `--no-start` | flag | off | Never start `operad serve`, even when none answers. |
| `--theme` | string | `theme` in `$OPERAD_HOME/tui.json`, else `auto` | `auto`, `light`, `dark`, `terminal`, a family or a shipped theme (see Themes), or the name of a theme file of your own. Beats `tui.json` for this session. |
| `--token` | string | The token in `$OPERAD_HOME/secrets/http.json` | The bearer token of the running `serve`. |
| `OPERAD_HOME` | environment variable | `~/.operad` | The directory holding `config.json`, `secrets/http.json`, `serve.lock` and the `serve.log` a started `serve` writes. |
| `http.listen` | array of strings in `config.json` | `["127.0.0.1"]` | IP literals `serve` may listen on; the first one is the default TUI address. |
| `http.port` | integer in `config.json` | `7480` | `0` to `65535`; the TUI needs the port `serve` actually uses, so `0` needs `--url`. |

## The tui.json file

`$OPERAD_HOME/tui.json` holds this client's own settings. It is JSON; a missing
file means the defaults. The TUI watches the file and repaints when it changes.
A file that is not a JSON object, is not valid JSON, names a key other than the
two below and `$schema`, or names no known theme is refused with the file and
the problem; at start the TUI does not open.

<!-- schema: tui.schema.json -->
```json
{ "theme": "nord", "layout": "tree" }
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `theme` | string | `"auto"` | `auto`, `light`, `dark`, `terminal`, a family or a shipped theme, or the name of a theme file in `$OPERAD_HOME/themes` | At start and whenever `tui.json` changes; `--theme` beats it for one session | Refused: the TUI does not start and the message names the file and the unknown theme |
| `layout` | string | `"tree"` | `tree`, `list` | At start and whenever `tui.json` changes; `t` switches it for the session | Refused: the TUI does not start and the message names the file and the key |

`layout` says how an object page draws its next level: `tree` nests children
under the first sibling in their `after` order, and `list` shows one flat list.

## Themes

| Name | Look |
|---|---|
| `auto` (default) | `light` or `dark` by the terminal's theme mode, and it switches live when the terminal switches. |
| `light`, `dark` | The operad app's colours. |
| `terminal` | The terminal's own 16 colours (accent magenta, run blue, ok green, error red, weak bright black), so its scheme sets the look; it works without truecolor. |

An unknown name is an error that lists the names. An unknown theme in
`tui.json` is an error that names the file and the problem; the TUI does not
start. The keys of `tui.json` are in [its section](#the-tuijson-file).

The colours come from a theme. `theme` in `tui.json` chooses one; `--theme`
chooses one for a session. A theme file names only the tokens it changes;
`extends` fills the rest. A colour is `"#rrggbb"` or an ANSI index from 0 to 15.

<!-- schema: theme.schema.json -->
```json
{ "extends": "dark", "colors": { "accent": "#ff8800", "error": 9 } }
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `comment` | string | absent | a note for people: where the colours come from and their licence | When the file is read; it changes no colour | Ignored if it is text; any other type refuses the file |
| `extends` | string | `"dark"` | `light`, `dark`, `terminal`, a shipped theme, or another theme file | When the file is read; a cycle is refused | Refused: `theme not changed: <why>` while the last good theme stays; at start the TUI does not open |
| `colors` | object | `{}` | the token names below | When the file is read; a token left out comes from `extends` | Refused: an unknown token names the file and the key |
| `colors.text` | string or integer | inherited from `extends` | `"#rrggbb"` or an integer `0`–`15` | When the theme is drawn | Refused: a bad colour names the file and the key; the last good theme stays |
| `colors.weak` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; secondary text | When the theme is drawn | Refused, as above |
| `colors.rule` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; rules and borders | When the theme is drawn | Refused, as above |
| `colors.accent` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; what needs you | When the theme is drawn | Refused, as above |
| `colors.run` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; work in progress | When the theme is drawn | Refused, as above |
| `colors.ok` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; success | When the theme is drawn | Refused, as above |
| `colors.error` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; failure | When the theme is drawn | Refused, as above |
| `colors.cancelled` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; a cancelled object | When the theme is drawn | Refused, as above |
| `colors.add` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; added diff lines | When the theme is drawn | Refused, as above |
| `colors.remove` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; removed diff lines | When the theme is drawn | Refused, as above |
| `colors.tint` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; the selected row's background | When the theme is drawn | Refused, as above |
| `colors.code` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; a code block's background | When the theme is drawn | Refused, as above |
| `colors.background` | string or integer | inherited | `"#rrggbb"` or `0`–`15`; the fill of the palette, note, confirmation and key list boxes | When the theme is drawn | Refused, as above |

The tokens mean: `text`, `weak` (secondary text), `rule` (rules and borders),
`accent` (needs you), `run` (in progress), `ok` (success), `error`,
`cancelled` (a cancelled object), `add` and `remove` (diff lines), `tint` (the
selected row's background), `code` (a code block's background) and
`background` (the fill of the palette, note, confirmation and key list boxes). A file with the name of a built-in theme
(`auto`, `light`, `dark`, `terminal`, a family or a shipped theme) is refused. A
cycle in `extends`, an unknown token, a bad colour or an unknown key refuses the
file, names it, and leaves the last good theme in place.

### Popular themes

operad ships these palettes, each from its project's own repository (the source,
the licence and every contrast adjustment are in the `comment` of its file in
`packages/tui/themes/`, and the licence texts are next to the files). To pick
one, name it in `tui.json` (`{ "theme": "nord" }`) or pass `--theme nord`.

| Family (follows the terminal like `auto`) | Light | Dark |
|---|---|---|
| `catppuccin` | `catppuccin-latte` | `catppuccin-mocha` |
| `solarized` | `solarized-light` | `solarized-dark` |
| `tokyo-night` | `tokyo-night-day` | `tokyo-night-night` |
| `one` | `one-light` | `one-dark` |
| `rose-pine` | `rose-pine-dawn` | `rose-pine-main` |
| `github` | `github-light` | `github-dark` |
| `kanagawa` | `kanagawa-lotus` | `kanagawa-wave` |

Name a family and the TUI shows its light member in a light terminal and its dark
member in a dark one, and switches live like `auto`. Name a member to keep it
whatever the terminal does. These have no pair and are always the same: `dracula`, `nord`,
`catppuccin-frappe`, `catppuccin-macchiato` and `kanagawa-dragon` (all dark).
Gruvbox is not shipped because its repository has no licence file.

### Your own themes

`theme` may also name a theme file, `$OPERAD_HOME/themes/<name>.json` (JSON
Schema: `packages/tui/theme.schema.json`). It names only the tokens it changes;
`extends` (`light`, `dark`, `terminal`, a shipped theme or another theme file; `dark` when
absent) fills the rest. A colour is `"#rrggbb"` or an ANSI index from 0 to 15:

```json
{ "extends": "dark", "colors": { "accent": "#ff8800", "error": 9 } }
```

A cycle in `extends`, an unknown token, a bad colour or an unknown key is an
error naming the file and the key. A file with the name of a built-in theme
(`auto`, `light`, `dark`, `terminal`, a family or a shipped theme) is refused.

Two examples are in `docs/themes/` and are not installed: `high-contrast.json`
and `low-saturation.json`. To start from one:

```sh
mkdir -p ~/.operad/themes
cp docs/themes/high-contrast.json ~/.operad/themes/mine.json
echo '{ "theme": "mine" }' > ~/.operad/tui.json
```

The TUI watches `tui.json` and the themes directory and repaints when either
changes, without a restart. A file that turns invalid keeps the last good theme
and the footer shows one line, `theme not changed: <why>`, until the next good
change.

Every theme defines the same tokens: `text`, `weak` (secondary text), `rule`
(rules and borders), `accent` (needs you), `run` (in progress), `ok` (success),
`error`, `add` and `remove` (diff lines), `tint` (the selected row's background)
`code` (a code block's background) and `background` (the fill of the palette, note, confirmation and key list boxes).

`operad tui` uses the terminal size: at 100 columns or wider the list and the
object pane sit side by side, and below 100 columns the list fills the screen
and an open object replaces it until `escape`. The header counts Pending and
Running and then names every plugin that has a tab. A plugin whose objects
belong under settings gets no tab: its objects are listed in the `:` palette's
settings area, one group per type, and open from there as from Pending,
Running or a group heading in another tab. The right pane says
`select an object` until a row is opened. `enter` opens the selected row with
`GET /v1/objects/<id>`: the pane starts with that row (id, title, state, note
badge and mark), then the section tabs in the server's order (History last), then the
section's Markdown. A live section has a dot on its tab and follows its end
while the pane is at the bottom (`following`); scrolling up stops following and
`End` resumes it. A section the server cut at its size cap shows a `Truncated`
hint and `f` loads the whole section. A failed request, or a refused event
stream such as a wrong token, shows its reason in the footer until
a fetch succeeds; the same messages are printed after the screen closes. The
list scrolls to keep the cursor in view, and a refresh keeps the selected object
when it is still there. With 100 columns or more the list and the object sit
side by side: the object follows the selected row (it opens about 150 ms after
the cursor stops), `j` / `k` and the arrows keep moving the list, and the keys
that scroll or switch sections act on the object. Under 100 columns the object
fills the screen: `enter` opens it, `escape` goes back, and `j` / `k` scroll it.
Switching tabs closes the object. On a type tab whose type declares filters,
`f` shows the next filter in the server's order (every start opens each tab on
the type's default; the choice is not saved). The header adds ` · <filter>` after
the tab and, unless the filter is `all`, ` · N hidden`. The selection stays on
the same object when the new filter still shows it, and moves to the first row
otherwise. An object that leaves the filter through a live update leaves the
list. Beside an open object, `f` loads the whole section when it is capped and
cycles the filter otherwise; the open object's next level follows that filter
too, so its progress bar and numbers count only the rows the list shows. On a
narrow screen with an object open it only loads the section. Every key the app
reads is below.

| Input | Type | Default | Allowed values |
|---|---|---|---|
| `1`–`9` | key | none | The tab with that number. |
| `tab` | key | none | The next tab. |
| `shift-tab` | key | none | The previous tab. |
| `enter` | key | none | Open the selected row as an object (under 100 columns; side by side it is open already). On the row that is already open it does nothing. |
| `↑` / `↓` | key | none | Move the list cursor one row; a list loads its next page near the end. Under 100 columns with an object open, scroll the section one line instead. |
| `j` / `k` | key | none | The same as `↓` / `↑`. |
| `PgUp` / `PgDn` | key | none | Scroll the open section by one page. At the end it asks the section for its `next` page. |
| `b` / `space` | key | none | The same as `PgUp` / `PgDn`. |
| `Home` / `End` | key | none | The top of the open section, or its end; `End` resumes following a live section. |
| `[` / `]` | key | none | Switch to the previous or next section tab. |
| `←` / `→` | key | none | The same as `[` / `]`. |
| `f` | key | none | Load a capped section with `full=true`. |
| `g` | key | none | The first row; under 100 columns with an object open, the top of the section. |
| `G` | key | none | The last row; under 100 columns with an object open, the end of the section (it resumes following a live section). |
| `r` | key | none | Fetch every list again, and the open object with its live sections. When the open section failed to load, it asks for that section again too. |
| `a` | key | none | Run the open object's main action, the first one the object offers now (the footer names it with its key). A key bound to an action (below) wins over `a`. On Pending, when the selected item's choices are not actions on its object, `a` opens those choices and answers the question. With no action, one footer line says so. |
| a bound key | key | `GET /v1/keys` | Run that action on the open object. A user binding in `keys.json` beats a plugin default on the same key. Reserved keys cannot be bound: `enter`, `return`, `escape`, `esc`, `tab`, the arrows (`up`, `down`, `left`, `right`), `pageup`, `pagedown`, `home`, `end`, `space`, `[`, `]`, `:`, `?`, `/`, `b`, `f`, `g`, `j`, `k`, `n`, `p`, `q`, `r`, `t` (letters in either case) and `1`–`9`, as well as Ctrl-C and any Ctrl or Meta chord. A plugin default or `keys.json` entry on a reserved key is dropped; at start one footer line names each dropped key with its action and source. The action stays reachable from the `:` palette, with no key shown. If the object does not offer the action now, one footer line says it is not available. |
| `:` | key | none | Open the palette: type to fuzzy match the `plugin:action` names the open object offers, each with its key and "needs a note" or "asks to confirm", the TUI's own commands and the settings. A plugin whose objects belong under settings lists them here in a group named after each type; `enter` opens that object's page. `↑` / `↓` (or Ctrl-P / Ctrl-N) move, `enter` runs, `escape` closes. With no object open it lists nothing but "no object is selected". |
| note input | key | none | An action with a note field opens a text input. Typing adds text, `backspace` deletes, `shift-enter` or `Ctrl-J` adds a line, `enter` sends and `escape` cancels. A required note cannot be sent empty. |
| confirmation | key | none | An action that asks to confirm shows `<action> <id>? [y/N]` in red. `y` sends it with `confirmed: true`; any other key cancels. |
| `?` | key | none | Show or hide the key list. |
| `q` | key | none | Quit. |
| `Ctrl-C` | key | none | Quit at once. The terminal restores itself; no other Ctrl or Meta chord does anything. |
| `escape` | key | none | Close the key list, or close the open object and stop its requests. While the key list is open only `?`, `escape` and `q` act; the others leave the list alone. |

## `keys.json`

`$OPERAD_HOME/keys.json` overrides the key bindings that plugins ship. It is a
JSON object whose key is a key name and whose value is an action name,
`<plugin>:<action>`. A user binding beats a plugin default on the same key. A
binding on a reserved key is dropped; at start one footer line names each
dropped key with its action and source, and the action stays in the `:` palette
with no key shown. A value that is not a loaded action is ignored with one
logged line, however it is spelled.

<!-- schema: keys.schema.json -->
```json
{ "m": "dev:merge", "g": "dev:reject", "n": "dev:rework" }
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `keys.<name>` | string | no override | any non-empty string; an action that is loaded is normally written `<plugin>:<action>` | When the plugins load; a running `serve` reloads when the file changes, and the TUI reads the bindings from it | Refused only when the value is empty or not a string, or the file is not a JSON object: `key bindings "<path>": <reason>`. A non-empty value that names no loaded action is ignored with `key "<key>": "<action>" is not a loaded action; the key is ignored` |

The reserved keys are `enter`, `return`, `escape`, `esc`, `tab`, the arrows
(`up`, `down`, `left`, `right`, and their `arrow` names), `pageup`,
`page-up`, `prior`, `pagedown`, `page-down`, `next`, `home`, `end`, `space`,
`[`, `]`, `:`, `?`, `/`, `b`, `f`, `g`, `j`, `k`, `n`, `p`, `q`, `r`, `t`
(letters in either case) and `1`–`9`, as well as Ctrl-C and any Ctrl or Meta
chord. A reserved key cannot be bound.

## Live updates, states and leaving

The screen follows the event stream. An event for an object fetches that
object's row again in every open list and, if it is the open object, the object
and its open live sections. A `reset` (the server could not resume the stream,
or the stream reconnected with nothing to resume from) fetches every open list
and the open object again. Pending and Running are fetched again on any event.
Events that arrive together are served in one batch, at most one batch every
250 ms.

| State | What the screen shows |
|---|---|
| Server unreachable | One footer line, `no server at <url>: is `operad serve` running? retrying`. The last lists stay on screen, dimmed. The screen asks again after 250 ms, then 500 ms, 1 s, 2 s, 4 s and every 5 s, and returns to normal when the server answers. |
| 401 | `the token was rotated: run the TUI again or pass --token`. Nothing is retried; `q` quits. |
| Empty Pending | `nothing waits for you` |
| Empty list of an object type | `no <type title> yet` |
| A section that failed to load | The server's message and `r retries` in place of the section; `r` asks for that section again (and fetches the lists again). |

`q`, Ctrl-C, SIGINT and SIGTERM all end the screen the same way: the event
stream is closed, the terminal is restored (alternate screen left, cursor
shown), failures collected while the screen was open are printed, and the
command exits 0. A `serve` that the TUI started keeps running.

A refused action shows the server's status and message as they came (for
example `409 …`) in one footer line until the next key. After a success the app
fetches the lists and the open object again.
