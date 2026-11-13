---
description: A plugin's storage: the object store, versions and facts, where filters, paging, cursors, the logger and the memory store.
---

# Storage

A plugin keeps its objects in the store `ctx.store`, an `ObjectStore`. The kernel keeps the run log; a plugin never opens it and never opens the store's file.
A SQLite file `<home>/store/plugins.sqlite` holds the objects (`openPluginStore({ backend: "sqlite", root })` opens it); `MemoryPluginStore({ root, clock? })` keeps them in the process for tests and one-shot use. `SqlitePluginStore` and `MemoryPluginStore` are the two classes; a plugin uses the store it is given.
A worker that runs a step reopens the same store from `store.location`, so the step sees the same data; an in-memory store has no location, and `kind` is `"file"` or `"memory"`.

## The object store

| Call | Returns | What it does |
|---|---|---|
| `put(type, id, data, cause)` | the stored object | Stores a new **version** of the object and appends the change as a fact. `data` is JSON-shaped; `cause` names what made the change (`notes/draft`, `action:notes/publish`). A change is never an update in place: `version` counts up |
| `get(type, id)` | the object or `undefined` | `{ type, id, data, version, cause, at }` |
| `list(type, { where?, cursor?, limit?, index? })` | `{ objects, next? }` | One page of objects of `type`, **ordered by id**, filtered by `where`. `next` is the cursor of the next page |
| `facts(object, { cursor?, limit? })` | `{ facts, next? }` | One page of one object's facts in sequence order |
| `facts()` | every fact | In append order, when the store keeps them in memory |
| `subscribe(listener)` | an unsubscribe function | Tells the listener whenever an object gains a fact. A store that cannot watch returns a no-op |
| `subscribe(object, { cursor? }, listener)` | an unsubscribe function | The same call subscribed to one object's facts: facts after `cursor`, or only those appended after the subscription starts |
| `declare(type, index)` | | Tells the store which fields `where` may filter on. The registry calls it from each object type's `index` |
| `root` | string | The directory that holds this store's files, such as logs |

The plugin's own store (`PluginStore`) also has `append(input)` for a fact that is not an object change; a plugin writes those through `ctx.facts.append({ type, data, object?, cause? })`. A fact holds data and paths, **never process output**: write output to `ctx.logger` and put the path in the fact.
A fact's `cause` is the one you give; when you give none the kernel fills the call that wrote it (`action:<plugin>/<name>`, `command:<plugin>/<name>`, `standing:<plugin>`, `tick:<plugin>`, `source:<plugin>`, `check:<plugin>`, or `step:<plugin>/<name>` for a step), so a history line can say why something changed.

## Filters, pages and cursors

| What | Value | A wrong value |
|---|---|---|
| `where` | An object of `field: value` equality filters; the value is a string, number, boolean or `null`. Only fields in the type's `index` may be named | `<label>: where: field "<f>" is not indexed; indexed fields are "a", "b"` (or `this type declares no index`); `where.<f>: must be a string, number, boolean or null` (a `WhereError`) |
| `limit` | A positive integer, `100` by default (`DEFAULT_PAGE_LIMIT`), at most `1000` (`MAX_PAGE_LIMIT`); a larger one is lowered to the maximum | `limit: must be a positive integer` |
| `cursor` | The `next` of an earlier page; opaque. A cursor carries the type, the filter's fingerprint and the position, so a cursor is refused when the filter changed | `list "<t>": invalid cursor` (a `CursorError`) |

`pageLimit(value)`, `assertWhere(index, where, label)`, `whereFingerprint(where)`, `canonical(value)` (a stable text form used to compare values), `encodeCursor(payload)` and `decodeCursor(text, label)` are the helpers the two stores share; a plugin that pages something of its own (a section's `next`) may use them.
A plugin that lists everything loops until `next` is absent.

## The logger

`ctx.logger.write(text)` appends a line (a newline is added when missing) to a file under `<store>/logs/` named by the plugin, the kind of call and its name (`logs/notes/actions/publish.log`) and returns the path; `createPluginLogger(storeRoot, ...segments)` makes one. Each segment is cleaned to letters, digits, `.`, `_` and `-`.
Put the returned path in a fact.

## Objects and the log

The store holds objects and their facts. The run log is separate: it holds each run's facts (steps entered, results, answers) and the global inputs, and only the kernel and the runner write it. A plugin reads a run through the views (`ctx.runTimes` in a view) and writes to the log only by returning results.

## Rules

- Open nothing yourself: use `ctx.store`. A SQLite file of your own must open with the settings in [the platform module](platform.md#sqlite-open-settings).
- Never put a secret in `data` or in a fact; use [secrets](settings.md#secrets).
- Declare `index` for every field you filter on; an unindexed `where` is refused.
