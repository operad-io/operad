---
description: A plugin's settings: the schema, the config.json section, defaults, editing from a client, project settings, secrets and key bindings.
---

# Settings, secrets and keys

A plugin declares the settings it reads with a JSON Schema, `settings`; the person writes them in the plugin's entry in `config.json`; the plugin reads them as `ctx.settings`.

```ts
settings: {
  type: "object",
  properties: {
    greeting: { type: "string", default: "hello", editable: true, description: "What a note starts with." },
    limits: {
      type: "object",
      properties: { words: { type: "integer", minimum: 1, default: 200, editable: true, confirm: true } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
},
```

```json
{
  "plugins": {
    "notes": { "module": "./notes/index.ts", "settings": { "greeting": "hi", "limits": { "words": 300 } } }
  }
}
```

## The entry in `config.json`

`plugins.<name>` is a module name (a string) or an object. The file's own schema is `packages/engine/config.schema.json`; [config.json](../user/config.md#plugins) explains the keys for a person.

| Key | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `plugins.<name>` | string or object | none | A string is the module to import; an object has the keys below | When a process loads plugins | Refused at read with the file and the field |
| `plugins.<name>.module` | string | the plugin name | A module name or a path (a path gets a fresh module instance at each load) | At load; a running `serve` reloads when the file changes and the new load probe passes | `plugin "<module>": no default export`; an import error naming the module; the plugin is skipped and the rest load |
| `plugins.<name>.enabled` | boolean | `true` | `true`, `false`. A disabled plugin is not loaded; its stored objects stay. `operad plugin disable <name>` refuses while a run of its flows is active | At the next command; a running `serve` reloads | Refused at read |
| `plugins.<name>.settings` | object | `{}` | Must fit the plugin's `settings` schema | At load; a view that reads `settingsInForce` follows an edit without a restart | The plugin is refused: `plugin "<name>": settings: <what is wrong>` |

## The schema

The schema is the [args subset](actions.md#the-args-schema). The root is `type: "object"`.
At load the kernel reads the plugin's section, fills every declared `default` into an absent field (recursively, through nested objects and arrays), validates the result and hands the plugin a deep-frozen copy:

| Step | What happens |
|---|---|
| The section is missing | It is treated as `{}`; defaults are filled |
| The section is not an object | `plugin "<name>": settings: must be an object` |
| A value does not fit | `plugin "<name>": settings.<path>: <what>`, e.g. `plugin "notes": settings.limits.words: must be at least 1`. The message names the plugin and the field and never a secret |
| An unknown field with `additionalProperties: false` | `plugin "<name>": settings.<field>: is not a field of this action` |

A plugin whose settings do not fit is refused (the other plugins load). `prepareSettings(schema, section, plugin)` is the function that does this.
`ctx.settings` is read at the start of each call, so a step that is already running keeps the values it started with.

The keys of the plugins that ship with operad are tabled in [config.json](../user/config.md#plugin-settings); every key there comes from the plugin's own `settings` schema, and a test fails when a key has no row.

## Editing a setting

A client may change a setting (`operad settings set`, the app's settings view) when its leaf property says so:

| Keyword | Meaning |
|---|---|
| `editable: true` | A client may change this setting. Without it: `setting "<name>" cannot be changed here` |
| `confirm: true` | The change needs the person's confirmation: `setting "<name>" needs confirmation` until it is given |
| `default` | Shown as the default and used for the value when the file has none |
| `description` | Shown beside the setting |
| `enum` | A client offers a pick list |

A *leaf* is a property that is not an object with `properties`; the objects are walked and their leaves named by the dotted path, `<plugin>.limits.words`. An object property marked `editable: true` is itself one leaf (the person writes the whole object).
The value is checked against the leaf's schema and then the whole section is checked again before the file is written; a value that does not fit is refused, naming the setting, and nothing is written.
The file is written atomically (a temporary file, then a rename), under a lock. Two places that declare the same name in one scope are refused: `setting "<name>" is declared twice in the global scope: ...`. A name nobody declares is `no setting "<name>"`.

## Project settings

A plugin whose settings live per repository declares `projectSettings`:

```ts
projectSettings: {
  repositories: async ({ store }) => [{ name: "notes", path: "/home/me/notes" }],
  files: [{ name: "notes", path: "notes.json", schema: { type: "object", properties: { tag: { type: "string", editable: true } } } }],
},
```

| Field | Type | Allowed values | A wrong value |
|---|---|---|---|
| `repositories` | function | `({ store }) => { name, path }[]`: the registered repositories whose `.operad/` holds the files | `repositories: must be a function of ({ store })` |
| `files[].name` | string | Lowercase letters, digits and `-`; unique. The setting's qualified name is `<plugin>.<name>.<path>`, or `<plugin>.<path>` when the name equals the plugin's | `name: must be lowercase letters, digits and -`; `name "<n>" is declared twice` |
| `files[].path` | string | A relative `.json` path under the repository's `.operad/`, no `..` | `path: must be a relative .json path under .operad/ without ".."` |
| `files[].schema` | schema | An object schema; required | `schema: is required` |
| `files[].check` | function | `(ProjectSettingsContext) => string \| undefined`: run on the whole file as it would be written, after the schema and before the write. A string refuses the change with that reason, as it is, and nothing is written | `check: must be a function` |
| `files[].derived` | function | `(ProjectSettingsContext) => { <property>: JsonValue }`: read-only values worked out when settings are listed; a property with no stored value takes the value here | `derived: must be a function` |

`ProjectSettingsContext` is `{ repository, value }`: the repository and the file's JSON object.

A repository that is not registered: `no registered repository "<r>"; registered: <names>`.

## Secrets

`ctx.secrets` is the plugin's own store: `get(name)` returns a `Secret<string>` or `undefined`, `set(name, value)`, `delete(name)` and `names()`.
Secrets are one `0600` JSON file per plugin (`<home>/secrets/<plugin>.json`) in a `0700` directory, outside the fact log. A name is letters, digits, dot, dash or underscore and starts with a letter or a digit (`secret "<n>": must be letters, digits, dot, dash or underscore`).
A `Secret` hides its value: `toString()` gives `[Secret]`, and `JSON.stringify` throws (`SecretSerializationError`), so a secret cannot reach a fact by accident. Call `.reveal()` on purpose, where the value is used; `secret(value)` makes one.
A person manages them with `operad secret set|list|delete <plugin> <name>`; a value is read from the terminal without echo, or from the first line of stdin.
`FileSecretStore({ home, plugin })` is the class behind `ctx.secrets`, `secretsDirectory(home)` and `secretsPathFor(home, plugin)` name its files.

## Key bindings

`keys` maps a key to an action, `"m": "notes:publish"`. The person's `keys.json` has the same shape and wins for the same key; `keysPathFor(home)` is its path and `readKeysFile(path)` reads it (a missing file is no overrides; invalid JSON is `key bindings "<path>": invalid JSON: ...`). Each action must be `<plugin>:<action>`.
The key names are the terminal client's; see [the terminal client](../user/tui.md).
