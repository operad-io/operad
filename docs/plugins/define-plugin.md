---
description: definePlugin and every field it takes: type, default, allowed values, when a change takes effect and what a wrong value does.
---

# definePlugin and its fields

`definePlugin(shape)` returns the shape with `operadPlugin: 1` added (`OPERAD_PLUGIN_VERSION`).
The value is plain data: nothing runs when it is created.
The plugin's module exports it as its default export, and a module that has none is refused with `plugin "<module>": no default export`.

```ts
import { definePlugin } from "@operad-io/engine";

export default definePlugin({
  name: "notes",
  kind: "domain",
  version: "0.1.0",
});
```

`definePlugin` keeps the literal types of what you pass (`const P extends PluginShape`), so a flow's result names stay checked by the compiler.
The registry checks the whole declaration again at load; a wrong value is refused there, not at the call to `definePlugin`.

Check a declaration without starting anything: `operad plugin check <path>` loads the module together with the configured plugins and prints `<name>: ok` (exit `0`), or `<name>: <message>` (exit `1`) for the first problem. It does not check the plugin's `settings` against `config.json`.

## When a change takes effect

| When | What it means |
|---|---|
| At load | The module is imported and checked when a process loads its plugins: every `operad` command at its start, `serve` at its start, each run's process at its start. A change to the file or to `config.json` is read by the next process. A running `serve` notices the change on disk, starts a fresh process that loads it, and takes the new code up only when that probe loads without problems; otherwise the old code keeps running and the problems are logged. |
| Each call | The function is called each time it is used (`when` on each offer of an action, `row` on each list, `load` on each section read, `standing` on each pending view). A change takes effect at the next call of the code that is loaded. |

## Refused declarations

A malformed field throws `PluginError` with a message of the form `plugin "<name>": <field>: <what is wrong>`, naming the array index for a list entry (`plugin "notes": steps[0]: results: must be an array`).
The message is the whole report: nothing is partly loaded.
A plugin that is well formed but cannot be used is *refused* instead: the other plugins load, and the refusal is written to the error stream as one line (`operad plugin list` does not show it; it prints each configured plugin's name, version and whether it is enabled). These refusals are:

| Cause | Message |
|---|---|
| `settings` in `config.json` do not fit the schema | `plugin "<name>": <field>: <what is wrong>` (see [Settings](settings.md)) |
| `requires.api` is not met | `requires api "<range>", but this engine provides 1.0.0` |
| A plugin in `requires.plugins` is missing, disabled, refused or at another version | `requires plugin "<other>" "<range>", but "<other>" is not loaded` (or `is disabled`, `was refused`, `is <version>`) |
| A module fails to import | the import error, naming the module |
| `config.json` names a module that provides another plugin | `plugin "<entry>": unknown plugin; the module "<module>" provides "<name>"` |

## The fields

| Field | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `name` | string | required | Non-empty; unique among the loaded plugins; the prefix of the plugin's step names (`<name>/<step>`), actions (`<name>:<action>`) and event types | At load | `plugin[<i>]: name: must be a non-empty string`; a second plugin with the same name: `plugin "<name>": duplicate plugin name` |
| `kind` | string | required | `domain`, `harness`, `stage`, `channel`, `source`, `action` (see [the kinds](#the-kinds)) | At load | `plugin "<name>": kind: must be one of "domain", "harness", "stage", "channel", "source", "action"` |
| `version` | string | required | Non-empty; compared with other plugins' `requires.plugins` ranges | At load | `plugin "<name>": version: must be a non-empty string` |
| `objects` | list of [object types](views.md#object-types) | `[]` | Each entry has a unique non-empty `name`; no two plugins own one name | At load | `objects: duplicate object type "<t>"`; `object "<t>": another plugin already owns it` |
| `actions` | list of [actions](actions.md) | `[]` | Each `name` + `on` pair is unique; `on` names a loaded object type | At load | `actions: duplicate action "<a>" on object type "<t>"`; `action "<a>": on: unknown object type "<t>"` |
| `steps` | list of [step types](steps.md) | `[]` | Unique non-empty `name`; `results` is a list of distinct non-empty strings; a harness plugin's results are end results | At load | `steps: duplicate step "<s>"`; `steps[<i>]: results: must be an array`; `step "<s>": duplicate result "<r>"` |
| `flows` | list of [flows](flows.md) from `defineFlow` | `[]` | Each flow valid against the step types of every loaded plugin; names unique within the plugin | At load | `plugin "<name>": flow "<f>": step "<s>": <field>: <what>`; `flows: duplicate flow "<f>"` |
| `commands` | list of [commands](#commands) | `[]` | Unique non-empty `name`; `args` a string; `run` a function | At load | `commands: duplicate command "<c>"`; `commands[<i>]: args: must be a string` |
| `views` | record, object type name to [views](views.md) | `{}` | Each key names an object type of this plugin; each value has functions `row`, `sections`, `load`, optionally `showScope` | At load; the functions on each call | `views.<t>: the plugin declares no object type "<t>"`; `views.<t>: row: must be a function` |
| `keys` | record, key to action | `{}` | Each value is `<plugin>:<action>`; the person's `keys.json` overrides it | At load | `keys.<k>: must name an action as "<plugin>:<action>"` |
| `rules` | list of [trigger rules](events.md#rules) | `[]` | The same shape as `triggers.json`; each `start.flow` names a loaded flow | At load | the rule's own message; `rules: rule <i>: start.flow: unknown flow "<f>"` |
| `onTick` | function | not set | `(ctx: TickContext) => void` | Called on each pass of `serve`; code at load | `onTick: must be a function`; a throw is logged as `onTick failed: <message>` and the pass goes on |
| `standing` | function | not set | `(ctx: StandingContext) => StandingItem[]` | Each time the pending view is built | `standing: must be a function`; a throw is logged as `standing failed: <message>` and the plugin adds no items |
| `settings` | [settings schema](settings.md) | not set | An object schema in the [args subset](actions.md#the-args-schema) | At load; values at each use | `settings: <path>: <what>` |
| `objectsUnderSettings` | boolean | `false` | `true`, `false` | At load | `objectsUnderSettings: must be a boolean` |
| `projectSettings` | `{ repositories, files }` | not set | `repositories` a function; `files` a list of `{ name, path, schema }` (see [Settings](settings.md#project-settings)) | At load | `projectSettings: files[<i>]: path: must be a relative .json path under .operad/ without ".."` |
| `models` | `{ list, default }` or a function of the settings | not set | `harness` plugins only | At load; a function on each read | `models: only a harness plugin declares models` |
| `efforts` | `{ list, default, flag? }` | not set | `harness` plugins only; `default` is `null` or in `list`; `flag` a non-empty string | At load | `efforts: only a harness plugin declares efforts`; `efforts.default: must be null or one of the list` |
| `enforces` | list of strings | `[]` | Names of access-profile fields the plugin's steps apply, each unique and non-empty | At load | `enforces: duplicate field "<f>"` |
| `requires` | `{ plugins?, api? }` | not set | Ranges `^1.2.0`, `~1.2.0`, `>=1.2.0` or an exact version | At load | `requires.api: must be a supported version range (^, ~, >= or exact)` |
| `start` | function | not set | `(ctx: SourceContext) => SourceHandle`; called only for a `source` plugin | When `serve` starts; stopped when it exits | `start: must be a function`; a throw is logged as `start failed: <message>` and the other sources start |
| `check` | function | not set | `() => string | void`; the string is the check's note | When `operad init` checks the plugin | `check: must be a function` |

## The kinds

A kind says what a plugin is for. The kernel acts on the kind in these places only:

| Kind | What the kernel does with it |
|---|---|
| `domain` | Nothing special: a plugin that owns object types, steps, flows and actions (`dev`, `chat`, `bot`). |
| `harness` | A harness plugin may declare `models` and `efforts`; each of its step types may end only in an [end result](harness.md#end-results). Chats list the loaded harness plugins as the agents a person may pick. |
| `source` | Its `start` is called when `serve` starts, so it can [send events](events.md#a-source-plugin). |
| `stage` | A plugin whose steps other flows call (`shell`, `pool`). The kernel treats it like `domain`. |
| `channel`, `action` | Accepted names that no shipped plugin uses. The kernel treats them like `domain`. |

A kind is internal vocabulary: no user text names it.

## Commands

A command is a verb on the command line: `operad <plugin> <verb> [args]`, and `operad <verb>` when exactly one loaded plugin declares it and no kernel verb or other plugin has the name.

```ts
commands: [
  {
    name: "count",
    args: "[--all]",
    run: async (ctx, argv) => {
      const page = await ctx.store.list("note");
      return `${page.objects.length} notes`;
    },
  },
],
```

`args` is the usage text printed in help; the kernel does not parse it, and `argv` is the rest of the command line after the verb.
What `run` returns is printed: a string as it is, `undefined` as nothing, anything else as indented JSON.
A throw is printed as the error.
The context is the [base context](#the-context-every-hook-gets) plus `input`, the text read from stdin when the caller supplied one.

## The context every hook gets

Each hook (`run` of a step, action or command, `load`, `onTick`, `standing`, `start`, `check`) receives these fields:

| Field | Type | What it holds |
|---|---|---|
| `plugin` | string | The plugin's name. |
| `home` | string | The operad home directory. |
| `cwd` | string | The directory the command was started in, or the run's. |
| `store` | `ObjectStore` | The plugin's [objects](storage.md). |
| `facts` | `FactWriter` | `append({ type, data, object?, cause? })` records a fact of your own. |
| `logger` | `PluginLogger` | `write(text)` appends a line to a log file under the store and returns its path; `path` is that file. Put the path in a fact; never put process output in one. |
| `signal` | `AbortSignal` | Aborted when the call is cancelled. |
| `settings` | record | The plugin's `config.json` section, validated, with defaults filled. |
| `secrets` | `SecretStore` | `get`, `set`, `delete` and `names` of this plugin's [secrets](settings.md#secrets). |
| `runs` | `RunControl` | `cancel(runId)` of a run this plugin owns; set when the host can cancel. |

Steps, actions, ticks and sources add fields of their own; they are on [Steps](steps.md#the-step-context), [Actions](actions.md#the-action-context), [`onTick`](#ontick) and [Events](events.md#a-source-plugin).

## `onTick`

`onTick(ctx)` runs on each pass of `serve`, so a plugin can look at the world and start work. Its context adds:

| Field | What it does |
|---|---|
| `start(flow \| { flow, params?, object?, trigger?, access? }, object?, access?)` | Asks the kernel to start a run of one of this plugin's flows. |
| `declareFlow(flow)` | Adds a flow the plugin generated, so `start` can name it. The same name with the same definition is a no-op; a different definition under a name in use is refused. |
| `answer(runId, choice, note?)` | Answers the person wait of a run this plugin owns; a run that no longer waits rejects with a `StateError`. |
| `runLookup` | `active(object?)`, `state(runId)` and `lastStep(runId)` of the runs, when the loop supplies it. |
| `loaded` | The names of the plugins this process loaded. |

A throw in `onTick` is logged (`plugin "<name>": onTick failed: <message>`) and the pass goes on with the next plugin.

## `standing`

`standing(ctx)` returns the items the pending view shows that wait on no run: a problem the plugin sees and a person should act on.
See [Pending items](pending.md#standing-items).

## `keys`

`keys` maps a key to an action, as `{ "m": "dev:merge" }`, and is the default a client binds.
The person's `keys.json` in the operad home has the same shape and replaces a plugin's binding of the same key.
The key names are those of the client; see the key table of [the terminal client](../user/tui.md).

## `requires`

```ts
requires: { api: "^1.0.0", plugins: { shell: "^0.0.0" } },
```

`api` is checked against `PLUGIN_API_VERSION` (`1.0.0`), each entry of `plugins` against the loaded plugin's `version`.
`satisfiesRange(version, range)` and `isRangeSyntax(range)` are exported for the same check.
A range is `^x.y.z` (up to the next major; `^0.y.z` up to the next minor; `^0.0.z` only that patch), `~x.y.z` (up to the next minor; `~x` up to the next major), `>=x.y.z` or an exact version.
A plugin whose requirement is not met is refused (see [Refused declarations](#refused-declarations)).

## What the engine exports

The names a plugin imports are listed, with the page that explains each, in [Exports](exports.md).
