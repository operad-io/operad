# ADR 0013: Actions Are Commands

Status: accepted

## Background

A client (command line, TUI, iOS, web page) knows no plugin. Otherwise every new plugin would change every client, and a plugin an agent writes on the spot could not be used on a phone at once. A plugin only produces content, a client only renders, and the kernel carries it.

## Decisions

### D1: An action is a command named `plugin:action`

On the command line: `operad dev:confirm <id>`; `operad dev confirm <id>` is accepted too, and `operad confirm <id>` when it does not clash. In the TUI, `:` opens the command palette, which fuzzy-matches `plugin:action`, acts on the selected object, and lists only the actions it can use together with their bound keys. iOS lists the same actions in the `⋯` menu of an object page. When no object is selected, the palette lists commands that need no object (for example `dev:task-add`).

### D2: An action declares its parameters (JSON Schema) and `confirm`

A string with `role: "note"` in the parameters is a description to fill in (for example `dev:reject`), and `confirm: true` asks for confirmation before executing (for example `dev:merge`, `dev:cancel`). The command line generates `--<name>` from the schema. In a terminal, a missing required note is prompted for; `confirm` asks `[y/N]`, and `--yes` skips it.

### D3: Keys have two layers

A plugin can carry default bindings (`{ "m": "dev:merge" }`). A user overrides them in `~/.operad/keys.json` in the same format, and the user's wins. When two plugins' default keys clash, the one loaded second does not take effect, a line is shown at startup, and the palette still works.
