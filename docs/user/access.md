---
description: Access profiles, access-user.json and always allow.
---

# Access

An agent asks before it runs a command or touches a path its access profile does not allow. A person answers the question with an action; `allow_always` records the call so the question does not come again.

## `access-user.json`

`$OPERAD_HOME/access-user.json` (see [the home](config.md#the-home)) holds the calls a person answered `allow_always` for. A missing file is an empty list. A file that cannot be read is reported by the step that reads it and treated as empty. A person adds an entry by answering `allow_always` and removes one by deleting its line.

Each entry binds an exact command and the working directory it was allowed in, or a tool, a path and a working directory.

| Key | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `kind` | string | required | `command`, `path` | When a step asks about a call: an entry matches only a call of its kind. |
| `value` | string | required | The command text exactly as allowed (for an MCP tool, `mcp <server>.<tool>`), or the path as the call wrote it | When a step asks about a call: the call must match it exactly. |
| `cwd` | string | required | A directory path | The working directory the call was allowed in. |
| `tool` | string | required for `path` | A tool name such as `write` or `edit` | The tool a path entry allows on that path. |
