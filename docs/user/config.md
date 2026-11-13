---
description: The config.json file: where the home is, every section and key, and every plugin's settings.
---

# config.json

`config.json` configures `operad`. This page says where the home is, every key of the file, and every plugin's settings section. The `http` keys are also on [the HTTP page](http.md#the-http-section), the `notify` keys on [notifications](notifications.md), the `mcp` keys on [the MCP page](mcp.md), and the repository settings of `dev` on [the dev page](dev.md).

## Why it exists

Operad needs one place to keep what a person has set up: which plugins are installed, where the store is and which interfaces are on. That place is the home directory and its `config.json`. The file is written by `operad init` when the home has none, and changed afterwards by hand or with `operad plugin enable` and `operad plugin disable`. Operad does not rewrite a home that already has a `config.json`, and it keeps no hidden defaults for the file that `operad init` writes.

## How it works

1. A command finds the home: `$OPERAD_HOME` when it is set and not blank, otherwise `~/.operad`. It reads `config.json` there; with no file, there are no plugins.
2. The kernel reads only the keys it names: `plugins`, `store`, `http`, `notify`, `mcp` and `ask`. A wrong value in one of them refuses the file with one line; an unknown key is ignored.
3. For every entry in `plugins` that is not disabled with `"enabled": false`, the kernel imports its `module` (the key's name when `module` is not given) and checks the entry's `settings` with that plugin's own schema.
4. A plugin that does not import, has invalid settings or declares another name does not load. The rest still load, and `serve` and `operad plugin check` print the line that says why.
5. A disabled plugin is not imported; its stored objects stay.
6. A one-shot command reads the file again on its next run. A running `serve` watches the file and reloads when the new file loads; when it does not load, the old configuration keeps running and the problem is logged. A step that has already started keeps the settings it started with.

The keys are in [The sections](#the-sections) and each plugin's settings in [Plugin settings](#plugin-settings).

## The home

`operad` keeps its state in one directory: `$OPERAD_HOME` when it is set, and
`~/.operad` otherwise. The home holds `config.json`, the store, the secrets
directory, `access-user.json`, `keys.json`, `triggers.json`, `tui.json` and the
themes directory. A secret file is mode `0600` inside a `0700` directory;
nothing in this manual prints a secret.

## An example

<!-- schema: config.schema.json -->
```json
{
  "plugins": {
    "shell": { "module": "@operad-io/shell", "enabled": true },
    "cron": { "module": "@operad-io/source-cron", "enabled": true },
    "chat": { "module": "@operad-io/chat", "settings": { "speaker": "Operad Bot" } },
    "dev": { "module": "@operad-io/dev", "settings": { "checks": 2 } },
    "pool": { "module": "@operad-io/pool", "settings": { "harnesses": { "pi": 2 } } },
    "bot": {
      "module": "@operad-io/bot",
      "settings": {
        "bots": {
          "default": {
            "harness": "pi",
            "model": "opencode-go/deepseek-v4.1-flash",
            "effort": "medium",
            "cwd": "~/work/assistant",
            "skills": ["~/work/assistant/skills"],
            "speaker": "Assistant",
            "mcpAllow": ["notes.search"],
            "access": { "readOnly": true, "askCommands": ["git push"] }
          }
        }
      }
    },
    "claude": {
      "module": "@operad-io/harness-claude",
      "settings": {
        "model": "sonnet",
        "effort": "high",
        "command": "claude",
        "maxTurns": 40,
        "budgetUsd": 10,
        "bashTimeoutSecs": 1800,
        "wallTimeSecs": 3600,
        "stallSecs": 600,
        "concurrency": { "sonnet": 2 }
      }
    },
    "pi": {
      "module": "@operad-io/harness-pi",
      "settings": {
        "model": "opencode-go/deepseek-v4.1-flash",
        "models": ["opencode-go/deepseek-v4.1-flash", "openai/gpt-5"],
        "thinkingLevel": "medium",
        "command": "pi",
        "authPath": "~/.pi/agent/auth.json",
        "modelsPath": "~/.pi/agent/models.json",
        "wallTimeSecs": 3600,
        "stallSecs": 600,
        "bashTimeoutSecs": 1800,
        "concurrency": { "opencode-go/deepseek-v4.1-flash": 2 }
      }
    },
    "radian": {
      "module": "@operad-io/harness-radian",
      "settings": {
        "command": "radian",
        "wallTimeSecs": 300,
        "stallSecs": 600,
        "concurrency": { "anthropic/claude-sonnet-4": 1 }
      }
    }
  },
  "store": { "backend": "sqlite", "path": "store/log.sqlite" },
  "http": { "enabled": true, "port": 7480, "listen": ["127.0.0.1"] },
  "notify": { "command": "sh ~/.operad/notify.sh", "on": ["waiting"] },
  "mcp": {
    "channel": { "notify": ["waiting", "ended", "loop"], "loopAfter": 3 },
    "actions": ["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency", "chat:close"],
    "confirmActions": ["chat:close"]
  },
  "ask": { "graceSecs": 600 }
}
```

`operad init` writes a `config.json` when the home has none: `shell`, `radian`,
`chat` and `dev` installed, the store at `store/log.sqlite`, `http` on at
`127.0.0.1:7480`, notifications off, the `mcp.actions` and `mcp.confirmActions`
lists above and the ask grace of 600 seconds. All of it is written into the
file; nothing in it is a hidden default. A home with no `config.json` at all
has no plugins and allows no lead action.

An existing home is never rewritten. `operad init` on a home that has a
`config.json` keeps the file as it is; the one exception is a file with no
`plugins` key, which gets the default plugins added and nothing else. A
`config.json` without `mcp.actions` allows no lead action. A home made before
this change lists its plugins already but may have no `mcp.actions`; to keep
the lead's actions, add these lines to its `mcp` section and restart
`operad mcp`:

```json
"mcp": {
  "actions": ["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency", "chat:close"],
  "confirmActions": ["chat:close"]
}
```

Enabling a plugin later does not add its actions to `mcp.actions`; add them by
hand.

Every top-level section is optional. The kernel reads only the keys it names:
an unknown key at the top level, inside an engine section (`store`, `http`,
`notify`, `mcp`, `ask`) or inside a `plugins` entry is ignored. The one place a
typo is refused is `plugins.<name>.settings`, which is checked by that plugin's
own schema; an unknown key there refuses the plugin with one line naming the
plugin and the field.

## The sections

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `plugins` | object, or an array of module names | the four plugins `operad init` installs | plugin name to a module name, a path, or an options object | At every command start, and when a running `serve` reloads after a change | Refused: `plugins: must be an object of plugin options or an array of module names` |
| `store` | object | sqlite at `<home>/store/log.sqlite` | the keys below | At every command start | Refused: `store: must be an object` |
| `http` | object | on, port `7480`, `127.0.0.1` | the keys on [the HTTP page](http.md#the-http-section) | When `operad serve` starts; a reload when the new config loads | Refused: `http: must be an object`, or the field's own message |
| `notify` | object | command `null`, `on` `["waiting"]` | the keys on [notifications](notifications.md) | When `operad serve` starts; a reload when the new config loads | Refused: `notify: must be an object`, or the field's own message |
| `mcp` | object | the lists below | the keys below | When `operad mcp` starts | Refused: `mcp: must be an object`, or the field's own message |
| `ask` | object | `{ "graceSecs": 600 }` | the keys below | When a step asks a person | Refused: `ask: must be an object`, or `ask.graceSecs: ...` |

The kernel reads `config.json` when a command starts. A running `serve` watches
the file and reloads when the new file loads; when it does not load, the old
configuration keeps running and the problem is logged. A one-shot command reads
the file again on its next run.

### `plugins`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `plugins` | object or array | `[]` in a file with no `plugins` section | plugin name to a module or an options object; an array entry is a module name | When plugins load | Refused: `plugins: must be an object of plugin options or an array of module names` |
| `plugins.<name>` | string or object | none | a non-empty module name or path, or an object with the keys below | When plugins load | Refused: `plugins.<name>: must be a module name or an object of options` |
| `plugins.<name>.module` | string | the key `<name>` itself | a module name, a path relative to the home, or a `file:` URL; the shipped packages are `@operad-io/<name>`, or `@operad-io/harness-<name>` for `claude`, `pi` and `radian` | When plugins load | Refused: `plugins.<name>.module: must be a non-empty string` |
| `plugins.<name>.enabled` | boolean | `true` | `true` or `false` | When plugins load; a disabled plugin's stored objects stay | Refused: `plugins.<name>.enabled: must be a boolean` |
| `plugins.<name>.settings` | object | `{}` | the section that plugin's own settings schema accepts; see below | When plugins load | The plugin is refused, with one line `plugin "<name>": ...` naming the field; a plugin that needs it is refused too |

A plugin entry whose module fails to import, whose settings are not valid, or
whose declared name does not match its key does not load. The rest of the file
still loads, and `serve` and `operad plugin check` print the line that says why.
`operad plugin list`, `operad plugin enable`, `operad plugin disable` and
`operad plugin check` are on [the CLI page](cli.md).

`operad init` installs `shell`, `radian`, `chat` and `dev`. `pi`, `claude`, `codex`,
`pool`, `bot` and `telegram` are shipped but not installed; enable one with
`operad plugin enable <name>`.

### `store`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `store.backend` | string | `"sqlite"` | `"sqlite"` only | At every command start | Refused: `store.backend: must be "sqlite"` |
| `store.path` | string | `<home>/store/log.sqlite` | a non-empty path; a relative path resolves against the home | At every command start | Refused: `store.path: must be a non-empty string` |

The store is what the history and pending views read. Changing the path makes
the new process read another history; it does not move the old file.

### `mcp`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `mcp.channel` | object | `{ "notify": ["waiting", "ended", "loop"], "loopAfter": 3 }` | the keys below | When `operad mcp` starts | Refused: `mcp.channel: must be an object` |
| `mcp.channel.notify` | array of strings | `["waiting", "ended", "loop"]` | `waiting`, `ended`, `loop`, `changes` | When `operad mcp` starts | Refused: `mcp.channel.notify: unknown entry <value>; use "waiting", "ended", "loop", "changes"` |
| `mcp.channel.loopAfter` | integer | `3` | `2` or more | When `operad mcp` starts | Refused: `mcp.channel.loopAfter: must be an integer of 2 or more` |
| `mcp.actions` | array of strings | `[]` (`operad init` writes the five `dev` lead actions and `chat:close` into a new file) | `<plugin>:<action>` names | When `operad mcp` starts | Refused: `mcp.actions: must be an array of "<plugin>:<action>" names` |
| `mcp.confirmActions` | array of strings | `[]` (`operad init` writes `["chat:close"]` into a new file) | `<plugin>:<action>` names that are also in `mcp.actions` and ask to confirm | When `operad mcp` starts | Refused: `mcp.confirmActions: must be an array of "<plugin>:<action>" names` |

`mcp.actions` is the list the MCP server may run for a lead. Every other action
is refused for the owner to run. `mcp.confirmActions` is the smaller list of
allowed actions that also need `confirm: true`; an action in `actions` but not
here is refused even when the MCP call confirms it. The channel keys are
explained on [the MCP page](mcp.md#claude-code-channel).

### `ask`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `ask.graceSecs` | number | `600` | `0` to `2147483` seconds; `0` does not wait | When a step calls `ctx.ask` without a narrower grace | Refused: `ask.graceSecs: must be a number of seconds from 0 to 2147483` |

The step's own `askGraceSecs` param, or the call's own grace, can be narrower.
There is no unlimited value; use the largest allowed number when a person may
answer after a long time. Asking is described in
[Asking a person from a step](../plugins/asking.md).

## Plugin settings

Plugin settings sit under `plugins.<name>.settings`. A plugin with no settings
schema has no keys: `shell` and the cron source (`cron`, the
`@operad-io/source-cron` package) are configured entirely by their flow steps and
by `triggers.json`. `review-grading` is a library that reads
`<repository>/.operad/review.json`, documented on [the dev page](dev.md#reviewjson).
The MCP server, the terminal client, the HTTP interface and notifications are
configured by the sections above, not by plugin settings.

Every setting is read when the plugin loads. A running `serve` reloads when
`config.json` changes and the new file loads; a step that has already started
keeps the settings it started with. The exceptions are named in each table.

### `bot`

The `bot` section describes chats that belong to a bot. The default bot
`default` exists even when it is not written. Names are lowercase letters,
digits, `-` and `_`, and start with a letter or digit; any other name refuses
the bot with `bot "<name>": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`.
A bot is read again at every reply, so an edit applies to the next reply. See
[Chats and bots](chats-and-bots.md).

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `bot.bots` | object | `{ "default": {} }` | bot name to a bot object | Next reply | Refused by the schema; a bad name refuses that bot |
| `bot.bots.<name>` | object | `{}` | the keys below | Next reply | Refused: `bot "<name>": ...` or the schema's field message |
| `bot.bots.<name>.cwd` | string | `~/.operad/bot` for `default`, `~/.operad/bot/<name>` for another bot | a directory inside `~/.operad/bot`, or outside the operad home entirely | Next reply and the next chat start | Refused: `bot "<name>": the working directory <path> is inside the operad home but outside <bot dir>` or `... is the operad home or holds it` |
| `bot.bots.<name>.harness` | string | the first loaded agent a chat offers | a loaded agent plugin name, such as `claude` or `pi` | When a new chat starts | A name that is not an agent is refused when the chat starts |
| `bot.bots.<name>.skills` | array of strings | `[]` | directories that hold a `SKILL.md`; a relative path is under the working directory | Next reply | Refused: `skill "<path>": there is no SKILL.md in <path>` |
| `bot.bots.<name>.model` | string | the agent's default | a model the chat's agent lists | When a new chat starts | Refused at chat start when the agent does not list it |
| `bot.bots.<name>.effort` | string | the agent's default | an effort the chat's agent lists | When a new chat starts | Refused at chat start when the agent does not list it |
| `bot.bots.<name>.speaker` | string | the `chat.speaker` value | non-empty text | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers` | object | `{}` | server name to a server object; add one with `operad bot mcp`, which a person approves | Next reply | Refused by the schema; a server whose tools changed is not mounted |
| `bot.bots.<name>.mcpServers.<name>` | object | none | the keys below | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.command` | string | none | the program that starts the server | Next reply | Refused by the schema; a missing command means the server cannot start |
| `bot.bots.<name>.mcpServers.<name>.args` | array of strings | `[]` | the program's arguments | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.package` | string | none | the package the command runs, when it runs one | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.version` | string | none | the pinned version of that package | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.secrets` | array of strings | `[]` | variable names; each value is the bot plugin's secret `<server>.<variable>` | When the server starts | Refused by the schema; a missing secret is given as empty |
| `bot.bots.<name>.mcpServers.<name>.tools` | array of objects | `[]` | the tools a person approved | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.tools.name` | string | required | a tool name | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.tools.description` | string | `""` | the tool's description | Next reply | Refused by the schema |
| `bot.bots.<name>.mcpServers.<name>.digest` | string | none | the digest of the tool names and descriptions | Next reply | A chat that finds other tools does not mount the server |
| `bot.bots.<name>.mcpAllow` | array of strings | `[]` | `<server>.<tool>` or `<server>.*` | Next reply | Refused by the schema |
| `bot.bots.<name>.access` | object | `{}` | the keys below; added to the default access profile | Next reply | Refused by the schema |
| `bot.bots.<name>.access.denyPaths` | array of strings | `[]` | paths; appended to the default list | Next reply | Refused by the schema |
| `bot.bots.<name>.access.denyCommands` | array of strings | `[]` | command rules; appended to the default list | Next reply | Refused by the schema |
| `bot.bots.<name>.access.askCommands` | array of strings | `[]` | command rules; appended to the default list | Next reply | Refused by the schema |
| `bot.bots.<name>.access.askPaths` | array of strings | `[]` | paths; appended to the default list | Next reply | Refused by the schema |
| `bot.bots.<name>.access.readOnly` | boolean | `false` | `true` turns the bot's working directory read-only; a bot can tighten the default, never loosen it | Next reply | Refused by the schema |

The default profile and the meaning of each access field are on
[the access page](access.md). `mcpAllow` has the same meaning as the profile's
`allowMcp`; an unlisted MCP tool asks first.

### `chat`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `chat.speaker` | string | `"Operad Bot"` | non-empty text | When a chat transcript is rendered | Refused by the schema |

A bot chat uses its bot's `speaker` instead. See [Chats and bots](chats-and-bots.md).

### `telegram`

The Telegram plugin is optional; its `users`, `bot` and `pending` settings and its
secret `token` are on [the Telegram page](telegram.md).

### `dev`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `dev.checks` | integer | `2` | `1` or more | When the next check takes a place; checks already waiting or running keep theirs | Refused by the schema; the plugin is refused and the log names `settings.checks` |

`dev.checks` is the most checks (a task's verify, and the checks before a merge)
that run at once in this home, across every repository. A repository can lower
its own share with `gate.places` in [its dev.json](dev.md#the-gate-and-its-checks).

### `pool`

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `pool.harnesses` | object | `{}` | harness plugin name to a count | When the next `pool/agent` step starts; steps already going keep their place | Refused by the schema; the plugin is refused and the log names `settings.harnesses` |
| `pool.harnesses.<name>` | integer | no cap for that harness | `1` or more | When the next `pool/agent` step starts | Refused by the schema |

The count covers every run through `pool/agent` in this home for that harness,
across repositories and flows. A flow that calls a harness step directly does
not count, but the harness's own `concurrency` still applies. See [Sharing
agents between flows](dev.md#sharing-agents-between-flows-the-pool-plugin).

### `claude`

The `claude` plugin runs Claude Code. Its step is `claude/agent`; see
[the dev page](dev.md#long-commands-under-claude).

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `claude.model` | string | claude's default, `sonnet` for a new chat | a model name claude takes, such as `opus` or `sonnet` | When an agent step or a new chat starts | Refused by the schema |
| `claude.effort` | string | claude's default | `low`, `medium`, `high`, `xhigh`, `max` | When an agent step or a new chat starts | Refused by the schema |
| `claude.command` | string | `"claude"` | a command name or path | When an agent step starts | Refused by the schema; a command that is not claude fails the plugin check |
| `claude.maxTurns` | integer | no limit | `1` or more | When an agent step starts | Refused by the schema |
| `claude.budgetUsd` | number | no limit | `0.01` or more | When an agent step starts | Refused by the schema |
| `claude.bashTimeoutSecs` | integer | `1800` | `1` or more seconds | When an agent step starts | Refused by the schema |
| `claude.wallTimeSecs` | number | `3600` | `1` to `28500` seconds | When an agent step starts | Refused by the schema; a larger value also fails the step with `must be at most 28500` |
| `claude.stallSecs` | number | `600` | `1` or more seconds | When an agent step starts | Refused by the schema |
| `claude.concurrency` | object | `{}` | model name to a count of `1` or more | With the next agent step that starts, at most the count for that model | Refused by the schema; the count's key is named |
| `claude.concurrency.<name>` | integer | no limit for that model | `1` or more | With the next agent step for that model | Refused by the schema |

`maxTurns` and `budgetUsd` are limits for one run; unset means no limit.
`budgetUsd` is for API-key logins. `bashTimeoutSecs` is the longest one Bash
call may run, in the foreground. `concurrency` counts every run in the home,
including the ones `dev` starts; a change does not stop runs already going.

### `codex`

The `codex` plugin runs the user's own Codex through `codex-acp`. Its step is
`codex/agent`; how to set it up and the settings are on
[the dev page](dev.md#the-codex-settings).

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `codex.model` | string | Codex's default | a model name codex-acp offers | When an agent step starts | Refused by the schema; a model codex-acp does not offer fails the step |
| `codex.effort` | string | Codex's default | `minimal`, `low`, `medium`, `high`, `xhigh` | When an agent step starts | Refused by the schema |
| `codex.command` | array of strings | the `bun` and the `codex-acp` of `PATH` | the program and its arguments | When an agent step starts | Refused by the schema; a command that cannot start fails the plugin check |
| `codex.wallTimeSecs` | number | `3600` | `1` to `28500` seconds | When an agent step starts | Refused by the schema |
| `codex.stallSecs` | number | `600` | `1` or more seconds | When an agent step starts | Refused by the schema |
| `codex.concurrency` | object | `{}` | model name to a count of `1` or more | With the next agent step that starts | Refused by the schema; the count's key is named |
| `codex.concurrency.<name>` | integer | no limit for that model | `1` or more | With the next agent step for that model | Refused by the schema |

### `pi`

The `pi` plugin runs pi. Its step is `pi/agent`; see [Long commands under
pi](dev.md#long-commands-under-pi).

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `pi.model` | string | pi's default model | `provider/id` | When an agent step or a new chat starts | Refused by the schema |
| `pi.models` | array of strings | every model `pi --list-models` prints | `provider/id` values | When a new chat lists its models | Refused by the schema |
| `pi.thinkingLevel` | string | pi's default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | When an agent step or a new chat starts | Refused by the schema |
| `pi.command` | string | `"pi"` | a command name or path that leads into an installed `@earendil-works/pi-coding-agent` | When the plugin loads and when an agent step starts | Refused by the schema; a missing or old install fails the plugin check |
| `pi.authPath` | string | `"~/.pi/agent/auth.json"` | pi's credentials file | When an agent step starts | Refused by the schema |
| `pi.modelsPath` | string | `"~/.pi/agent/models.json"` | pi's custom models file | When an agent step starts | Refused by the schema |
| `pi.wallTimeSecs` | number | `3600` | `1` to `28500` seconds | When an agent step starts | Refused by the schema; a larger value also fails the step with `must be at most 28500` |
| `pi.stallSecs` | number | `600` | `1` or more seconds | When an agent step starts | Refused by the schema |
| `pi.bashTimeoutSecs` | integer | `1800` | `1` or more seconds | When an agent step starts | Refused by the schema |
| `pi.concurrency` | object | `{}` | model name to a count of `1` or more | With the next agent step that starts, at most the count for that model | Refused by the schema; the count's key is named |
| `pi.concurrency.<name>` | integer | no limit for that model | `1` or more | With the next agent step for that model | Refused by the schema |

`authPath` and `modelsPath` are read by pi; `~` is the user's home. A change to
`concurrency` applies to the next step that starts; steps already going keep
their place.

### `radian`

The `radian` plugin runs radian. Its step is `radian/agent`.

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `radian.command` | string | `"radian"` | the radian executable: a name on `PATH` or a path | When an agent step starts | Refused by the schema; a command that cannot be found fails the step |
| `radian.wallTimeSecs` | number | `300` | a positive number of seconds | When an agent step starts | Refused by the schema |
| `radian.stallSecs` | number | `600` | a positive number of seconds | When an agent step starts | Refused by the schema |
| `radian.concurrency` | object | `{}` | model name to a count of `1` or more | With the next agent step that starts, at most the count for that model | Refused by the schema; the count's key is named |
| `radian.concurrency.<name>` | integer | no limit for that model | `1` or more | With the next agent step for that model | Refused by the schema |

Radian has no `model` setting; a step is limited by the `--provider` and
`--model` in its own arguments. A step without `--model` is not limited by
`concurrency`.

## `triggers.json`

`triggers.json` in the home holds the rules that say which event starts which
flow. It is a JSON array; a missing file means no rules of your own. A rule of
yours replaces a plugin rule with the same `source` and `type`; a plugin rule
for that pair is then not used.

<!-- schema: triggers.schema.json -->
```json
[
  {
    "source": "operad",
    "type": "dev.waiting",
    "start": { "flow": "dev", "params": {} },
    "object": "$event.object",
    "mode": "observe"
  },
  {
    "source": "cron",
    "type": "tick",
    "start": { "flow": "nightly" },
    "object": "flow:nightly",
    "mode": "auto",
    "schedule": "0 3 * * *"
  }
]
```

| Key | Type | Default | Allowed values | When it takes effect | Wrong value |
|---|---|---|---|---|---|
| `source` | string | required | the source that sends the event, such as `cron` or `operad` | When the file is read | Refused: `rule <n>: source: must be a non-empty string` |
| `type` | string | required | the event type, such as `tick` or `run.done` | When the file is read | Refused: `rule <n>: type: must be a non-empty string` |
| `start` | object | required | the keys below | When the file is read | Refused: `rule <n>: start: must be an object` |
| `start.flow` | string | required | a loaded flow name | When the file is read; an unknown flow is refused | Refused: `rule <n>: start.flow: unknown flow "<name>"` |
| `start.params` | any JSON value | absent | the flow's fixed parameters | When the rule starts the flow | Refused if it is not plain JSON: `rule <n>: ... is not JSON` |
| `object` | string | required | a fixed object id, or `$event.object` | When the rule starts a run | Refused: `rule <n>: object: must be a non-empty string` |
| `mode` | string | required | `observe`, `candidate`, `auto` | When the rule starts a run | Refused: `rule <n>: mode: must be "observe", "candidate", "auto"` |
| `schedule` | string | absent | a five-field cron expression in the local time zone | When a cron rule is loaded; only rules with source `cron` use it | Refused: `rule <n>: schedule: <why the cron expression is not valid>` |

The cron source is the plugin named `cron` from `@operad-io/source-cron`. It
emits one `tick` per due minute for each rule with `source` `cron` and a
`schedule`; other rules ignore `schedule`. A rule may not name the reserved
source `operad` when it is added by a command.

If `triggers.json` is not valid, the whole file is refused, with the rule and
field in the message. `operad serve` logs it and runs without sources until the
file is fixed; a command that needs a rule reports it. A running `serve` watches
the file and reloads when the new file loads.

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
