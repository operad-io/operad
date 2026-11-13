---
description: The config.json file: where the home is, every section and its keys.
---

# config.json

`config.json` configures `operad`. This page says where the home is, which sections the file has and what each does. The `http` section is on [the HTTP page](http.md#the-http-section); the `notify` section on [notifications](notifications.md); the `mcp` section is below and on [the MCP page](mcp.md).

## The home

`operad` keeps its state in one directory: `$OPERAD_HOME` when it is set, and
`~/.operad` otherwise. The home holds `config.json`, the store and the secrets
directory. A secret file is mode `0600` inside a `0700` directory; nothing in
this manual prints a secret.

## config.json

`config.json` is JSON. A missing file means the defaults below.

```json
{
  "plugins": {
    "shell": { "module": "@operad-io/shell", "enabled": true },
    "radian": { "module": "@operad-io/harness-radian", "enabled": true },
    "dev": { "module": "@operad-io/dev", "enabled": true }
  },
  "store": { "backend": "sqlite", "path": "~/.operad/store/log.sqlite" },
  "http": { "enabled": true, "port": 7480, "listen": ["127.0.0.1"] },
  "notify": { "command": null, "on": ["waiting"] },
  "mcp": {
    "actions": ["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency", "chat:close"],
    "confirmActions": ["chat:close"]
  },
  "ask": { "graceSecs": 600 }
}
```

- `plugins`: plugins keyed by name. Each entry is a module name or path, or an
  object with `module`, `enabled` and the plugin's own `settings`. The key can
  also be an array of module names.
- `store`: where the objects and their history live. `backend` is `sqlite`, the
  only one; `path` is the database file, `store/log.sqlite` in the home when
  absent. A relative path resolves against the home. Any other `backend` is a
  config error.
- `http`: the interface `operad serve` exposes to clients. It is off unless
  `enabled` is true; no other command opens the port.
- `ask`: how long `ctx.ask` waits for an answer by default; see
  [Asking a person from a step](../plugins/asking.md).
- `notify`: a command `serve` runs when something waits for a person; see
  [Notifications](notifications.md). It is off while `command` is `null`.
- `mcp`: the plugin actions the MCP server may run for a lead; see
  [MCP server](mcp.md).

## The `mcp` section

| Key | Type | Default | What it does |
|---|---|---|---|
| `mcp.actions` | array of `plugin:action` strings | `["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency", "chat:close"]` | The actions `operad mcp` may run. Every other action is refused with a message naming it and saying the owner runs it. |
| `mcp.confirmActions` | array of `plugin:action` strings | `["chat:close"]` | The allowed actions that also carry `confirm: true`. Such an action is refused even when `actions` names it unless this list names it too. |

Both lists take effect the next time `operad mcp` starts. They do not change an
action already running. The MCP server never offers the owner's actions as its
own; `show` lists them separately so the lead can tell the owner what to run.

## Settings from a client

`operad settings` lists the settings a person may tune and `operad settings set
<name> <value>` changes one; `--repo <name>` names a registered repository. A
global setting is `<plugin>.<path>`. A project file whose name equals its
plugin's name takes the plugin name alone, so `.operad/dev.json` is
`dev.concurrency`, `dev.autoDefault`, `dev.gate.commands`,
`dev.gate.commandTimeoutSecs`, `dev.reviewer.use`, `dev.reviewer.args`,
`dev.reviewer.timeoutSecs` and `dev.reviewer.fixLevel`. Another file adds its
name: `.operad/review.json` is `dev.review.default.levels`,
`dev.review.default.rules` and `dev.review.default.fixLevel`. Changing what
merges (`autoDefault`, a `fixLevel`, the levels and rules) asks for `--yes`.
