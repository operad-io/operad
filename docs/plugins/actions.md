---
description: Actions a plugin offers on an object: every field, the args schema keywords, the per-agent if/then shape, the context and the errors.
---

# Actions

An action is something a person can do to an object: a button in the app, a key in the terminal, `operad <plugin>:<action> <id>` on the command line, an MCP tool.
A plugin declares it on an object type and decides when it is available; the kernel checks the person's values and runs it.
The name a person types is `<plugin>:<action>` (or `<plugin>/<action>`, or the plain name when only one plugin offers it on that type).

```ts
actions: [
  {
    name: "publish",
    on: "note",
    args: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["blog", "mail"], default: "blog" },
        reason: { type: "string", role: "note", description: "Why." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    confirm: true,
    when: (state) => state.published === false,
    why: (object) => `${object.id} is already published`,
    run: async (ctx, args) => {
      await ctx.store.put("note", ctx.object.id, { ...ctx.object.data, published: true }, "notes/publish");
      return `published ${ctx.object.id}`;
    },
  },
],
```

## The fields

| Field | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `name` | string | required | Non-empty. A name and its `on` pair is unique | At load | `actions[<i>]: name: must be a non-empty string`; `actions: duplicate action "<a>" on object type "<t>"` |
| `on` | string | required | An object type some loaded plugin owns | At load | `action "<a>": on: unknown object type "<t>"` |
| `when` | function | required | `(data, env) => boolean`; the action is offered only when it returns `true`. A throw is logged (`when failed: <message>`) and the action is refused with `<object> cannot <action> now` | At load; at each offer and each run | `actions[<i>]: when: must be a function` |
| `run` | function | required | `(ctx, args) => string \| ActionOutcome \| anything` | At load; at each run | `actions[<i>]: run: must be a function` |
| `args` | [args schema](#the-args-schema) | not set (no arguments) | An object schema | At load | `actions[<i>]: args.<path>: <what>` |
| `argsFor` | function | not set | `(object, env) => schema`; replaces `args` each time the action is offered and checked, so it can follow what is loaded. `args` stays the static form for help. The result may carry [`allOf` with `if`/`then`](#per-agent-choices-with-if-and-then) | Each offer and each run | A result the person's values do not fit is refused like `args` |
| `confirm` | boolean | not set (`false`) | `true` makes the action ask for confirmation before it runs | At load | `actions[<i>]: confirm: must be a boolean` |
| `ends` | boolean | not set (`false`) | `true` when the action ends the object (a cancel). A client's main key or button never picks it, even when it is the only action | At load | not checked: only `true` counts |
| `creates` | string | not set | The object type the action creates (`"chat"`). A client keeps such an action out of the parent's page and offers it where the type is created; it is never an object's main action | At load | `actions[<i>]: creates: must be a non-empty string` |
| `rank` | function | not set (rank `0`) | `(data) => number`; lower comes first, equal ranks keep the plugin's order. The first available action is the main one. A throw counts as `0` | Each list of actions | not checked |
| `why` | function | not set | `(object, env) => string \| undefined`; the one line a client prints when the action is not available. It starts with the object's own name and says when the action becomes possible | Each refusal | not checked |
| `settled` | function | not set | `(object, args, env) => string \| undefined`; a line when the result is already true. The action then succeeds with that line and does not run. It is checked before `when`, with the arguments as sent. A throw is logged (`settled failed`) and ignored | Each run | not checked |

`env` holds `store` (read it, never write), `harnesses` (the loaded harness plugins), `models` and `efforts` (by plugin name).
A field named `note` is refused: `actions[<i>]: note: is no longer a field; declare a string property with role "note" in args`.

What `run` returns is the line a person reads, or nothing. An action that creates an object returns `{ text, opens }` (exactly those two string keys), where `opens` is the object as `type:id`; the kernel passes it on through `POST /v1/act` and the MCP `act` tool and a client may open that page. An `opens` that names no existing object is not passed on, and the log says why. See [What an action returns](index.md#what-an-action-returns).

## Order of the checks

When a person runs an action the kernel checks, in this order, and stops at the first refusal:

1. The object exists and the action is declared on its type.
2. `settled`: a line means success without running.
3. `when`: not `true` is refused with the `why` line, or `<object> cannot <action> now`.
4. The note: a `required` property with `role: "note"` that is missing or empty is refused with `action "<a>" needs a note; pass --<name> <text>`.
5. The values against the schema (`argsFor(...)` or `args`): `action "<a>": args.<field>: <what>`.
6. `confirm`: `action "<a>" needs confirmation; pass --yes` (over HTTP: `send "confirmed": true in the request body`).
7. Uploaded files are taken (a `format: "file"` argument) and the stored path replaces the reference.
8. `run`.

The action's own record, `action_invoked`, is written before `run`, with who asked; it is not the object's type, so it never changes the object's data. `registry.runAction(name, args, options)`, which a plugin or a test may call directly, validates the values and runs the action; it does not check `when`, the note or `confirm`.

## The args schema

`args`, `argsFor`, a plugin's `settings` and a project settings file take the same JSON Schema subset, checked when the plugin loads.
The root must be `type: "object"`: `actions[<i>]: args: type: must be "object"`.
A keyword that is not in the table is refused: `<path>: unknown keyword "<k>"`. `title`, `deprecated`, `readOnly`, `$schema` and `$id` are accepted and dropped.

| Keyword | Type | Meaning | A value that does not fit |
|---|---|---|---|
| `type` | `string`, `number`, `integer`, `boolean`, `array`, `object` | The kind of value. A `number` takes a whole number too; an `integer` takes only a whole number | At load: `<path>.type: must be one of string, number, integer, boolean, array, object`. A value: `args.<field>: must be a <type>, got <kind>` |
| `enum` | list of strings, numbers or booleans | The allowed values; a client offers a pick list | At load: `<path>.enum: must be an array of strings, numbers or booleans`. A value: `args.<field>: "x" is not one of "a", "b"` |
| `const` | any | The one value allowed | `args.<field>: must be <value>` |
| `default` | any | The value a client pre-fills and `settings` fills when the field is absent. The kernel **does not fill it** into an action's `args`: an omitted optional field stays omitted, so `run` must apply the default itself | not checked |
| `description` | string | Shown by help and in client forms | `<path>.description: must be a string` |
| `minimum`, `maximum` | number | Inclusive bounds of a number | `args.<field>: must be at least <n>` / `must be at most <n>` |
| `exclusiveMinimum`, `exclusiveMaximum` | number | Exclusive bounds of a number | `must be more than <n>` / `must be less than <n>` |
| `minLength`, `maxLength` | number | Bounds of a string's length in characters | `must be at least <n> characters` / `must be at most <n> characters` |
| `pattern` | string | A regular expression the string must match somewhere | At load: `<path>.pattern: is not a regular expression`. A value: `must be written as <pattern>` |
| `items` | schema | The schema of each element of an array. Only an array has items | At load: `<path>.items: only an array has items`. A value: the element's message with the index in the field, `args.list.0: ...` |
| `minItems` | number | The fewest elements | `must have at least <n> items` |
| `properties` | record of schemas | The fields of an object | A nested field's message names its dotted path |
| `required` | list of names | Fields that must be present; each must be a property | At load: `<path>.required: "<name>" is not a property`. A value: `args.<field>: is required` |
| `additionalProperties` | `false` or a schema | `false` refuses any other field; a schema checks the other fields | `args.<field>: is not a field of this action` |
| `minProperties` | number | The fewest fields of an object | `must have at least <n> fields` |
| `oneOf` | non-empty list of schemas | Exactly one branch must fit | At load: `<path>.oneOf: must be a non-empty array of schemas`. A value: the one branch of the value's kind explains itself, else `must be <a> or <b>`; two fitting: `fits more than one of the accepted forms` |
| `$defs`, `$ref` | record; `#/$defs/<name>` | A shared schema in the root's `$defs`, replaced by what it names at load. Fields beside `$ref` are merged over it | `<path>.$ref: must name an entry of the schema's $defs, as #/$defs/<name>`; `"<name>" refers to itself` |
| `role` | `"note"` | The string is the person's note: a terminal prompts for it and `--note` fills it; the property must have `type: "string"`. At most one is used (the first) | `<path>.role: must be "note"`; `a note property must have type "string"` |
| `format` | `"file"` | The string is a file a client uploaded: the client passes the upload's reference and `run` receives the stored path. An array of such strings takes several. Uploads are at most 20 MiB (`MAX_UPLOAD_BYTES`) and are kept for an hour (`UPLOAD_TTL_MS`) | `<path>.format: must be "file"`; `a file property must have type "string"`; a reference that is gone: `args.<field>: <the upload message>` |
| `editable`, `confirm` | boolean | Meaningful in a settings schema only: see [Settings](settings.md#editing-a-setting) | `<path>.<key>: must be a boolean` |

`validateActionArgs(schema, args, label)` returns `args` itself when it fits and throws `ActionArgsError`; `normalizeActionArgs(value, label)` is the load-time check; `noteProperty(schema)` finds the note field and `fileProperties(schema)` the file fields. A value that is `undefined` is treated as `{}`; one that is not an object is refused: `action "<a>": args: must be an object`.

### Per-agent choices with `if` and `then`

An `argsFor` result (and only that: `args` refuses the words) may carry `allOf`, a list of `{ if, then }` conditionals in standard JSON Schema.
A client reads them to narrow one field by another; **the kernel does not evaluate them** when it checks the person's values, so `run` must still refuse a value the chosen branch does not list.
The new-chat form uses this to offer each agent's own models and efforts, with that agent's default:

```ts
argsFor: (object, env) => ({
  type: "object",
  properties: {
    agent: { type: "string", enum: ["claude", "pi"] },
    model: { type: "string", enum: ["opus", "sonnet", "small", "large"] },
  },
  allOf: [
    {
      if: { properties: { agent: { const: "claude" } }, required: ["agent"] },
      then: { properties: { model: { type: "string", enum: ["opus", "sonnet"], default: "sonnet" } } },
    },
    {
      if: { properties: { agent: { const: "pi" } }, required: ["agent"] },
      then: { properties: { model: { type: "string", enum: ["small", "large"], default: "small" } } },
    },
  ],
  additionalProperties: false,
}),
```

One conditional per agent; an agent that lists no model gets no `model` property in its `then`, so nothing can be picked for it.
`agentConditionals(agents)` in `@operad-io/chat` builds this list from `{ name, models, efforts }`. The terminal client narrows `model` and `effort` by the chosen `agent`, and does not ask for a field the chosen agent's branch lists nothing for.

## The action context

An action's context has every field of [the base context](define-plugin.md#the-context-every-hook-gets) and:

| Field | Type | What it holds |
|---|---|---|
| `object` | `{ type, id, data }` | The object the action is on. |
| `actor` | `{ via, id }` | Who asked: `via` is the client (`cli`, `ios`), `id` the person. |
| `runId` | string \| undefined | Set when the action answers a person wait. |
| `answer(choice, note?)` | function \| undefined | Answers the run's current person wait; set when the action runs for a run. |
| `harnesses` | list of strings | The names of the loaded `harness` plugins. |
| `models`, `efforts` | records | The models and efforts each loaded harness plugin declares, by plugin name. |
| `emit(event)` | function \| undefined | Sends an [event](events.md#an-action-sends-an-event) through the rules; set when the host routes events. |

## Answering a wait from an action

An action that answers the person wait of a run calls `ctx.answer(choice, note?)`; the answer is recorded once and the runner applies it, the same as an answer given by a person through a client. A choice the wait does not offer is refused: `run <id>: "<choice>" is not one of "<a>", "<b>"`.
