---
description: The terminal client: arguments, views, keys, tui.json, keys.json, themes and states.
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
  to 15 seconds (probe time counts) for it to answer, and opens the screen. The
  `serve` runs with the same runtime and `operad` entry as the command you typed,
  with `$OPERAD_HOME` as its working directory, appends its output to
  `$OPERAD_HOME/serve.log`, and keeps running after you quit the TUI, because the
  hub keeps running flows. Stop it with `operad serve stop` (see
  [Stopping serve](cli.md#stopping-serve)) or press Ctrl-C in a terminal where
  you ran `operad serve` yourself. If it exits at once or never answers,
  `operad tui` fails with one error that names `serve.log` and shows its last
  lines; `serve.log` can hold plugin output, so read the lines before you paste
  them. If another `operad tui` started the `serve` first, this one waits for
  that `serve` to answer within the same 15 seconds.
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

## Arguments

| Input | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `--url <url>` | string | `http://<first http.listen address>:<http.port>`, which is `http://127.0.0.1:7480` with no `http` section | An `http` or `https` URL without credentials, a query or a fragment. | At start: the address to reach. With it, no `serve` is started. A missing value is `--url needs a value`. |
| `--no-start` | flag | off | `--no-start` | At start: never start `operad serve`, even when none answers. |
| `--theme <name>` | string | `theme` in `$OPERAD_HOME/tui.json`, else `auto` | `auto`, `light`, `dark`, `terminal`, a family or a shipped theme (see [Themes](#themes)), or the name of a theme file of your own. | At start: the theme for this session. It beats `tui.json`; a broken `tui.json` is still reported. A missing value is `--theme needs a value`. |
| `--token <token>` | string | The token in `$OPERAD_HOME/secrets/http.json` | The bearer token of the running `serve`. | At start: the token for every request. A missing value is `--token needs a value`. |
| `--url=…`, `--theme=…`, `--token=…` | string | as above | as above | The `=` form is accepted for all three. |
| `OPERAD_HOME` | environment variable | `~/.operad` | A directory path | At start: the directory holding `config.json`, `secrets/http.json`, `serve.lock`, `tui.json`, `keys.json`, `themes/` and the `serve.log` a started `serve` writes. |
| `http.listen` | array of strings in `config.json` | `["127.0.0.1"]` | IP literals `serve` may listen on; the first one is the default TUI address. | At start, without `--url`. |
| `http.port` | integer in `config.json` | `7480` | `0` to `65535`; the TUI needs the port `serve` actually uses, so `0` needs `--url`. | At start, without `--url`. |

Any other argument is `tui: unknown argument "<arg>"` (a usage error, exit 2).
Without a terminal, `operad tui` refuses with `tui needs a terminal`.

## Settings files

### `tui.json`

`$OPERAD_HOME/tui.json` holds the two choices the client reads at start and
saves when you pick a theme or switch the child layout. Its JSON Schema is
`packages/tui/tui.schema.json`.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `theme` | string | `"auto"` | `auto`, `light`, `dark`, `terminal`, a family name, a shipped theme name, or a theme file name under `$OPERAD_HOME/themes/` | Every start, and while the TUI runs. The `theme` command saves it here. `--theme` beats it for one session. |
| `layout` | string | `"tree"` | `"tree"`, `"list"` | Every start, and when `t` switches the child list; `t` saves the choice here. `tree` nests children under the first sibling in their `after`; `list` is one flat list. |

A missing file means both defaults. A file that is not a JSON object, is not
valid JSON, has a key other than `theme`, `layout` or `$schema`, or gives a
wrong type is an error that names the file and the problem, and the TUI does
not start:

- `<file> is not valid JSON: <reason>`
- `<file> must be a JSON object like {"theme": "dark"}`
- `<file> has an unknown key "<key>"; only "theme" and "layout" are allowed`
- `<file>: "theme" must be a string`
- `<file>: "layout" must be "tree" or "list"`

The TUI watches `tui.json` and `themes/` and repaints when either changes. A
file that turns invalid keeps the last good theme, and the footer shows
`theme not changed: <why>` until the next good change. A broken `tui.json` is
never overwritten by a choice.

### `keys.json`

`$OPERAD_HOME/keys.json` overrides the key bindings a plugin declares. Its JSON
Schema is `packages/engine/schemas/keys.schema.json`.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `keys` | object | `{}` | One entry per key | When the TUI starts: the whole override map. |
| `<name>` | string | none | `"<plugin>:<action>"` | When the TUI starts: the action bound to that key. It beats a plugin default on the same key; a value that is not `<plugin>:<action>` is refused when the file is read. |

The file is a JSON object whose property names are keys and whose values are
action names:

```json
{ "m": "dev:merge", "s": "chat:send" }
```

A key the TUI keeps for itself cannot be bound; a binding on one is dropped at
start, and one footer line names each dropped binding:
`reserved keys ignored: <key> (<action>, <source>), …`. The action stays
reachable from the `:` palette, with no key shown. Reserved keys are `enter`,
`return`, `escape`, `esc`, `tab`, the arrows (`up`, `down`, `left`, `right`,
`arrowup`, `arrowdown`, `arrowleft`, `arrowright`), `pageup`, `page-up`,
`prior`, `pagedown`, `page-down`, `next`, `home`, `end`, `space`, `[`, `]`,
`:`, `?`, `/`, `b`, `f`, `g`, `j`, `k`, `n`, `p`, `q`, `r`, `t` (letters in
either case), `1`–`9`, and any Ctrl or Meta chord.

### Theme files

A theme name that is not built in names `$OPERAD_HOME/themes/<name>.json`. Its
JSON Schema is `packages/tui/theme.schema.json`. A theme file names only the
tokens it changes; `extends` fills the rest.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `extends` | string | `"dark"` | `light`, `dark`, `terminal`, a shipped theme name, or another theme file name | When the theme is chosen; the palette is built from that base. A cycle, or a name that is not a theme, is an error that names the file. |
| `colors.<token>` | string or integer | the base theme's value | `"#rrggbb"` or an ANSI index from 0 to 15 | When the theme is chosen. An unknown token is `colors.<token> is not a token; the tokens are …`; a bad colour is `colors.<token> is <value>, not a colour; use "#rrggbb" or an ANSI index from 0 to 15`. |
| `comment` | string | not set | Any text | Never; it is a note for people (source, licence, adjustments). |
| `$schema` | string | not set | A schema path | Never; it only helps an editor. |

`theme.colors` is an object; every token below is a key of it. Each token's
value is a hex colour or an ANSI index.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `theme.colors` | object | the base theme's colours | Token names as keys | When the theme is chosen: an object of the tokens below. |
| `theme.colors.text` | string or integer | the base theme's `text` | `"#rrggbb"` or 0–15 | When the theme is chosen: ordinary text. |
| `theme.colors.weak` | string or integer | the base theme's `weak` | `"#rrggbb"` or 0–15 | Secondary text, hints and rules' labels. |
| `theme.colors.rule` | string or integer | the base theme's `rule` | `"#rrggbb"` or 0–15 | Rules and borders. |
| `theme.colors.accent` | string or integer | the base theme's `accent` | `"#rrggbb"` or 0–15 | What needs you. |
| `theme.colors.run` | string or integer | the base theme's `run` | `"#rrggbb"` or 0–15 | In progress. |
| `theme.colors.ok` | string or integer | the base theme's `ok` | `"#rrggbb"` or 0–15 | Success. |
| `theme.colors.error` | string or integer | the base theme's `error` | `"#rrggbb"` or 0–15 | An error. |
| `theme.colors.cancelled` | string or integer | the base theme's `cancelled` | `"#rrggbb"` or 0–15 | A cancelled object, apart from error and weak. |
| `theme.colors.add` | string or integer | the base theme's `add` | `"#rrggbb"` or 0–15 | An added diff line. |
| `theme.colors.remove` | string or integer | the base theme's `remove` | `"#rrggbb"` or 0–15 | A removed diff line. |
| `theme.colors.tint` | string or integer | the base theme's `tint` | `"#rrggbb"` or 0–15 | The selected row's background. |
| `theme.colors.code` | string or integer | the base theme's `code` | `"#rrggbb"` or 0–15 | A code block's background. |
| `theme.colors.background` | string or integer | the base theme's `background` | `"#rrggbb"` or 0–15 | The fill of the palette, note, confirmation and key list boxes. |

Every theme defines the same tokens: `text`, `weak` (secondary text), `rule`
(rules and borders), `accent` (needs you), `run` (in progress), `ok` (success),
`error`, `cancelled` (a cancelled object), `add` and `remove` (diff lines),
`tint` (the selected row's background), `code` (a code block's background) and
`background` (the fill of the palette, note, confirmation and key list boxes).

A file with the name of a built-in theme (`auto`, `light`, `dark`, `terminal`,
a family or a shipped theme) is refused. A file that is not a JSON object, has
an unknown key, or gives `extends` a wrong type is an error that names the file
and the key. Two examples are in `docs/themes/` and are not installed:
`high-contrast.json` and `low-saturation.json`.

## Themes

The colours come from a theme. Choose one in `tui.json` or for one session with
`--theme`. The JSON Schema is `packages/tui/tui.schema.json`.

| Name | Look |
|---|---|
| `auto` (default) | `light` or `dark` by the terminal's theme mode, and it switches live when the terminal switches. |
| `light`, `dark` | The operad app's colours. |
| `terminal` | The terminal's own 16 colours (accent magenta, run blue, ok green, error red, weak bright black), so its scheme sets the look; it works without truecolor. |

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

An unknown name is `unknown theme "<name>"; the themes are <names>`; when it came
from `--theme` the message ends ` given with --theme`, and when it came from
`tui.json` it ends ` in <file>`.

### Your own themes

`theme` may also name a theme file, `$OPERAD_HOME/themes/<name>.json`. It names
only the tokens it changes; `extends` (`light`, `dark`, `terminal`, a shipped
theme or another theme file; `dark` when absent) fills the rest. A colour is
`"#rrggbb"` or an ANSI index from 0 to 15:

```json
{ "extends": "dark", "colors": { "accent": "#ff8800", "error": 9 } }
```

A cycle in `extends`, an unknown token, a bad colour or an unknown key is an
error naming the file and the key. To start from an example:

```sh
mkdir -p ~/.operad/themes
cp docs/themes/high-contrast.json ~/.operad/themes/mine.json
echo '{ "theme": "mine" }' > ~/.operad/tui.json
```

## Views and layout

The header is `operad ─ Pending <n> · Running <n> · <tab> · <tab> …`: the two
kernel lists and then one tab per plugin that has a top-level object type. A
plugin whose objects belong under settings gets no tab: its objects are listed
in the `:` palette's settings area, one group per type, and open from there as
from Pending, Running or a group heading in another tab. The `chat` plugin gives
a Chat tab and `dev` gives a Repo tab; types below the top level (plan, task)
have no tab and open from a parent, Pending or Running.

At 100 columns or wider the list and the object pane sit side by side. Below 100
columns the list fills the screen and an open object replaces it until `escape`.
The right pane says `select an object` until a row is opened. `enter` opens the
selected row with `GET /v1/objects/<id>`: the pane starts with that row (id,
title, state, note badge and mark), then a progress bar when the object has a
next level, the child list, then the section tabs in the server's order (History
last), then the section's Markdown. A child row opens the object it names.

A live section has a dot on its tab and follows its end while the pane is at the
bottom (`following`); scrolling up stops following and `End` resumes it. A
section the server cut at its size cap shows a `Truncated` hint and `f` loads the
whole section. A section with pages shows `p` to pick one and `n` / `N` to step.

With 100 columns or more the object follows the selected row (it opens about
150 ms after the cursor stops), `j` / `k` and the arrows keep moving the list,
and the keys that scroll or switch sections act on the object. Under 100
columns the object fills the screen. Switching tabs closes the object.

On a type tab whose type declares filters, `f` shows the next filter in the
server's order (every start opens each tab on the type's default; the choice is
not saved). The header adds ` · <filter>` after the tab and, unless the filter
is `all`, ` · N hidden`. The selection stays on the same object when the new
filter still shows it, and moves to the first row otherwise. An object that
leaves the filter through a live update leaves the list. Beside an open object,
`f` loads the whole section when it is capped and cycles the filter otherwise;
the open object's next level follows that filter too, so its progress bar and
numbers count only the rows the list shows. On a narrow screen with an object
open it only loads the section.

An empty list says `nothing waits for you` on Pending, `nothing <filter> in
<type>` when a filter is on, and `nothing in <type>` otherwise. A list that has
not loaded says `loading…`.

## Keys

Every key the app reads is below. A plugin default or a `keys.json` entry on a
reserved key is dropped at start; `:` still reaches the action.

| Input | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `1`–`9` | key | none | The tab with that number. | At once; closes the open object. |
| `tab` | key | none | The next tab. | At once. |
| `shift-tab` | key | none | The previous tab. | At once. |
| `enter` | key | none | Open the selected row as an object (under 100 columns; side by side it is open already). On the open row it does nothing. | At once. |
| `↑` / `↓` | key | none | Move the list cursor one row; a list loads its next page near the end. Under 100 columns with an object open, scroll the section one line instead. | At once. |
| `j` / `k` | key | none | The same as `↓` / `↑`. | At once. |
| `PgUp` / `PgDn` | key | none | Scroll the open section by one page. At the end it asks the section for its `next` page. | At once. |
| `b` / `space` | key | none | The same as `PgUp` / `PgDn`. | At once. |
| `Home` / `End` | key | none | The top of the open section, or its end; `End` resumes following a live section. | At once. |
| `[` / `]` | key | none | Switch to the previous or next section tab. | At once. |
| `←` / `→` | key | none | The same as `[` / `]`. | At once. |
| `p` | key | none | Pick a page of the open section, when it has pages. | At once. |
| `n` / `N` | key | none | The next or previous page of the open section, when it has pages. | At once. |
| `f` | key | none | Load a capped section with `full=true`; otherwise, on a tab with filters, the next filter. | At once. |
| `g` | key | none | The first row; under 100 columns with an object open, the top of the section. | At once. |
| `G` | key | none | The last row; under 100 columns with an object open, the end of the section (it resumes following a live section). | At once. |
| `t` | key | none | Switch the child list between `tree` and `list`; the choice is saved in `tui.json`. | At once; only when the open object has children. |
| `c` | key | none | On a chat tab, start a new chat; the palette lists the parent (a repository or a bot). | At once; only on a tab whose type can be created. |
| `r` | key | none | Fetch every list again, and the open object with its live sections. When the open section failed to load, it asks for that section again too. | At once. A rotated token is not retried. |
| `a` | key | none | Run the open object's main action, the first one the object offers now (the footer names it with its key). A key bound to an action wins over `a`. On Pending, when the selected item's choices are not actions on its object, `a` opens those choices and answers the question. With no action, one footer line says `no action is available`. | At once. |
| a bound key | key | `GET /v1/keys` | Run that action on the open object. A user binding in `keys.json` beats a plugin default on the same key. If the object does not offer the action now, one footer line says `<action> is not available for <id>`. | At once. |
| `:` | key | none | Open the palette: type to fuzzy match the `plugin:action` names the open object offers, each with its key and "needs a note" or "asks to confirm", the TUI's own commands (help, refresh, go to a tab, new an object, theme, go back, quit) and the settings. A plugin whose objects belong under settings lists them here in a group named after each type; `enter` opens that object's page. `↑` / `↓` (or Ctrl-P / Ctrl-N) move, `enter` runs, `escape` closes. With no object open it lists nothing but "no object is selected". | At once. |
| note input | key | none | An action with a note field opens a text input. Typing adds text, `backspace` deletes, `shift-enter` or `Ctrl-J` adds a line, `enter` sends and `escape` cancels. A required note cannot be sent empty (`a note is required`). | At once. |
| action arguments | key | none | An action with arguments asks one field at a time; `↑` / `↓` pick an enum value, `enter` takes it, text is typed, `escape` cancels. A value outside the allowed set shows the allowed values. | At once. |
| settings | key | none | The palette lists each setting; `enter` opens it. An editable setting asks for a value or shows a list; one that asks to confirm shows `setting <name>? [y/N]`, and `y` sends it. A read-only setting only shows; `enter` or `escape` closes it. | At once. |
| confirmation | key | none | An action that asks to confirm shows `<action> <id>? [y/N]` in red. `y` sends it with `confirmed: true`; any other key cancels. | At once. |
| `?` | key | none | Show or hide the key list. | At once. |
| `q` | key | none | Quit. | At once. |
| `Ctrl-C` | key | none | Quit at once. The terminal restores itself; no other Ctrl or Meta chord does anything. | At once. |
| `escape` | key | none | Close the key list, leave a list inside the open object, return from a row opened there, or close the open object and stop its requests. While the key list is open only `?`, `escape` and `q` act; the others leave the list alone. | At once. |

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
| Server unreachable | One footer line, `no server at <url>: is `operad serve` running? retrying  q quit`. The last lists stay on screen, dimmed. The screen asks again after 250 ms, then 500 ms, 1 s, 2 s, 4 s and every 5 s, and returns to normal when the server answers. |
| 401 | `the token was rotated: run the TUI again or pass --token  q quit`. Nothing is retried; `q` quits. |
| Empty Pending | `nothing waits for you` |
| Empty list of an object type | `nothing in <type>`, or `nothing <filter> in <type>` when a filter is on |
| A section that failed to load | The server's message and `r retries` in place of the section; `r` asks for that section again (and fetches the lists again). |
| A theme file that turns invalid | `theme not changed: <why>` until the next good change. |

`q`, Ctrl-C, SIGINT and SIGTERM all end the screen the same way: the event
stream is closed, the terminal is restored (alternate screen left, cursor
shown), failures collected while the screen was open are printed, and the
command exits 0. A `serve` that the TUI started keeps running.

A refused action shows the server's status and message as they came (for
example `409 …`) in one footer line until the next key. After a success the app
fetches the lists and the open object again.

## Settings from the palette

The `:` palette lists the settings `/v1/settings` returns for the scopes it
knows: the global section of `config.json`, and the open object's repository
when there is one. A setting shows its name, current value, default and whether
it is editable. An editable setting sends `POST /v1/settings`; the server
validates the value and writes the file, and a refusal comes back as the footer
line. A setting that asks to confirm shows `setting <name>? [y/N]`.

`operad settings` and `operad settings set` use the same calls from the command
line; see [the command line](cli.md#options).
