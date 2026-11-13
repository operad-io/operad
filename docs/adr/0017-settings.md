# ADR 0017: Settings

Status: accepted

## Background

The kernel reads and writes settings, and the clients change them through the same API.

## Decisions

### D1: Two kinds of setting

Global settings are the section of each plugin in `~/.operad/config.json` (`plugins.<plugin>.settings`; the plugin declares the JSON Schema, and the kernel has validated it at load time). Project settings are JSON files a plugin declares, kept under `.operad/` in a registered repository (for example `review.json` of `dev`), and they also carry a schema.

### D2: Which settings can be changed

A plugin marks each changeable setting `editable: true` in its schema, and one that needs confirmation is also marked `confirm: true`. A setting without the mark can be seen by a client but not changed.

### D3: Two API calls

`settings [scope]` lists the settings (name, current value, default value, the description from the schema, whether it can be changed). `set <name> <value> [scope]` changes one setting. The kernel validates it against the schema; when it is invalid, it refuses and gives the reason from the schema, and writes nothing. When it is valid, it writes back to the file atomically (write a temporary file, then rename), keeps everything else in the file, and then makes the plugin read it again as if the file had been edited by hand.

### D4: One path for every client

The command line, the `:` palette of the TUI and the settings page of iOS all go through these two calls. A secret is not here; it is still handled only by `operad secret`.

### D5: Words

The user-visible words are "settings" (the commands `operad settings` and `operad settings set`), and the group names of the TUI `:` palette: actions, tui, settings.
