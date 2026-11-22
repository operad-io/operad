# ADR 0010: What a Plugin Declares

Status: accepted

## Background

The conversation, knowledge-base, memory, source and daily-collection scenarios must all be writable as plugins without changing the kernel. The principle is to add no feature: make existing primitives general, and add only what is missing. Each point below answers a requirement that a scenario raised; what no scenario needs is not added.

## Decisions

### D1: `settings`

Each plugin has one JSON Schema. The kernel validates that plugin's section of `config.json` and hands it to the plugin as `ctx.settings`. The choice of a backend, the path of a library and an OAuth application id all go here. A plugin has no configuration file of its own for them. (The per-repository `.operad/dev.json` of `dev` is its own object and is not covered.)

### D2: `secrets`

`ctx.secrets.get(name)` and `set(name, value)` are scoped per plugin and are stored outside the log (a 0600 file). A secret never enters a fact, a param, an environment variable or `history`. A login state and a scoped key are the same thing. The `Secret` type exists, and this is where it is kept.

### D3: Runs carry an access profile

A run carries an access profile, `ctx.access`, which is opaque to the kernel. A plugin declares the fields it can enforce (`enforces: ["denyPaths", "askCommands", …]`). The kernel refuses to start a run whose access profile requires a field that no one enforces, and names the field. The kernel does not sandbox; it only guarantees that no one silently ignores the access profile. A one-time grant (ADR 0008) is part of the access profile data.

### D4: Rules and requirements

The declaration has two more fields: **`rules`** (default trigger rules) and **`requires`** (the plugins and the plugin API version that it depends on, checked at load time and reported clearly).

### D5: The testing package

`@operad-io/engine/testing` offers a fake clock, an in-memory store, `runFlow`, `answer` and `emit`, so an agent can write and test a plugin without starting `serve`. This is the premise of the path "describe a need, an agent writes a plugin on the spot".

### D6: What stays out of the kernel

Per-token streaming, memory, search indexes, a plugin's backends, scheduling policy, channel delivery, client logic beyond Markdown rendering, and any platform's API are not in the kernel. A conversation scenario runs on the existing views and calls (`list conversation`, a `transcript` section, `act chat:send`), and that is the test that the contract is sufficient.

### D7: A plugin's check reports what is missing, and its guide says how to fix it

`check` already runs when `operad init` checks a plugin and may return one line of text. It may instead return `{ note?, missing }`, where `missing` is a list of items, each with a `name` (a short word, unique within the plugin) and a `description` (one sentence saying what is not set up). An empty list means set up. `note` is the line `operad init` prints; without one it prints the descriptions joined by `; `. The one-line form is unchanged, and a `check` that throws is still a failed check. The check only reads; what it reports is judged by code, never by an agent's say-so.

A plugin may also declare `guide`, the absolute path of a `SKILL.md` (ADR 0011 D2) written for a bot: the steps that set the plugin up, each one for an item the check can name. A step is one of four kinds: the person does something outside operad and comes back; the person types a secret into a masked field (D2); a settings change is proposed and a person approves it (ADR 0030); the plugin checks something once and the check says so. The kernel carries the text and reads no meaning into it. A bot is told which items are missing and follows only those steps; "set up" is what the check says.

The setup guide of a plugin is read through `ctx.setup` (commands and actions): `list()` names the plugins that have a guide, and `get(name)` answers the guide's text with the check's `missing` items. A plugin that is off is not loaded (ADR 0012 D2), so its check is not run; its guide is still read from its module, and its one missing item is `enable` ("the plugin is off"). A plugin that is not in `config.json` has no guide to read; adding it is `operad plugin add`.

Over HTTP, a plugin's row in `GET /v1/plugins` carries `guide: true` when it has a guide, and `GET /v1/plugins/<name>/setup` answers `{ plugin, enabled, missing }`, so a client can put a "Setup <name>" button on the row and show what is missing on the plugin's page. The answer carries the check's items and never the guide's text. Every guide is called Setup followed by the plugin's name, capitalised (Setup Dev, Setup Telegram; Chinese 配置 followed by the name).
