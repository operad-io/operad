---
description: Object types and how they appear: object type fields, rows, sections (live, mark, tail, after, the size cap and the timeout) and filters.
---

# Object types and views

A plugin owns **object types** (`objects`), stored by the plugin in its [store](storage.md), and says how each one appears to every client with **views** (`views`, keyed by type name).
Clients (the terminal, the app, HTTP, MCP) all read the same list, row and section API, so a view is written once.
The kernel adds one section to every object itself, `history` (`HISTORY_SECTION`), and a plugin may not declare a section with that id.

## Object types

`objects` is a list of these:

| Field | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `name` | string | required | Non-empty; unique in the plugin and among all loaded plugins | At load | `objects[<i>]: name: must be a non-empty string`; `objects: duplicate object type "<t>"`; `object "<t>": another plugin already owns it` |
| `schema` | any | not set | Kept with the declaration; the kernel does not check data against it | At load | not checked |
| `index` | list of strings | `[]` | The data fields a `where` filter may name; each unique and non-empty. The registry tells the store with `declare(type, index)` | At load | `index: must be an array of field names`; `index[<j>]: must be a non-empty string`; `index: duplicate field "<f>"` |
| `filters` | list of filters | none | See [filters](#filters) | At load | `filters: ...` (below) |
| `resolve` | function | not set | `(ctx, type, id) => string \| undefined`: turns a bare id into the store key, or `undefined` when this type does not claim it. The kernel asks this before its own suffix lookup, so a plugin can scope an id to a repository. `ctx` holds `cwd`, `scope` (a `--repo` the person named) and `store` | At load; each lookup | `resolve: must be a function` |
| `prepare` | function | not set | `({ store, home, settings }) => void`: brings stored objects up to date (after a rename, say). It runs once per process before the first list or get, and must be safe to run again. A throw is tried again at the next read | At load; once per process | `prepare: must be a function` |
| `answeredAutomatically` | function | not set | `(data, { store }) => boolean`: true while the plugin will answer this object's wait for a person itself. It runs each time the pending view is built, so a wait whose automatic answer is refused stops being marked. A wait answered automatically is not announced | Each pending view | `answeredAutomatically: must be a function` |

### Filters

A filter is a named subset of a type's rows, by `state`:

| Field | Type | Default | Allowed values | A wrong value |
|---|---|---|---|---|
| `name` | string | required | Non-empty, unique in the type, not `all` (the kernel adds `all`) | `name: "all" is added by the kernel`; `name: duplicate filter "<f>"` |
| `states` | list of strings | required | Non-empty; each a non-empty row `state` | `states: must be a non-empty array of state names` |
| `default` | boolean | `false` | At most one filter is the default; with none marked the first is | `default: must be a boolean`; `default: "<f>" is already the default filter` |

`all` is placed right after the default filter. A row whose state is `error` is shown by every filter. `typeFilters(definition)` and `filterShows(filter, state)` implement this, and `ALL_FILTER` is the name `all`.

## Views

`views` maps an object type of this plugin to four functions:

| Function | Signature | Required | What it does | A wrong value |
|---|---|---|---|---|
| `row` | `(object) => ObjectRow` | yes | The one line a list shows. Must be pure, synchronous and fast: it reads the stored object and nothing else | `views.<t>: row: must be a function`; see [the row](#the-row) |
| `sections` | `(object) => ViewSection[]` | yes | The section directory only; it reads no content | `views.<t>: sections: must be a function`; `sections must return an array`; `each section must be { id, title, live? }` |
| `load` | `(ctx, object, sectionId, options) => SectionContent` | yes | Called when a person opens a section; may be slow and paged | `views.<t>: load: must be a function`; see [sections](#sections) |
| `showScope` | `(ctx) => boolean` | no | Whether a list shows each row's `scope` beside its id because more than one namespace exists. Read once per list | `views.<t>: showScope: must be a function` |

The `ctx` of `load` and `showScope` is [the base context](define-plugin.md#the-context-every-hook-gets) plus `runTimes(runId)` (when a run started and ended and its steps and waits, in order), `settingsInForce(plugin)` (the plugin's settings as `config.json` has them now, so a view follows an edit without a restart) and `refreshedObject(type, id)` (an object after its `prepare` with the settings in force).

### The row

An `ObjectRow` is `{ id, title, state, ... }`. The three first fields are required; the others are optional:

| Field | Type | Allowed values | A wrong value |
|---|---|---|---|
| `id` | string | The object's id | `row must return { id, title, state, note? }` |
| `title` | string | The line's text | the same |
| `state` | string | The object's state name; a filter matches it | the same |
| `note` | string | A short tail such as a cost or a duration | ignored when not a string |
| `wait` | string | Why the object waits, whole, separate from `note` | ignored when not a string |
| `scope` | string | The namespace the id is unique in, such as a repository; shown only when `showScope` says so | ignored when not a string |
| `final` | boolean | `true` when `state` is final for the type: the object will not move on. A client that reports ends reads this and no state name | only `true` counts |
| `mark` | string | One of `ROW_MARKS`: `todo`, `blocked`, `retry_wait`, `paused`, `proposed`, `starting`, `running`, `reconciling`, `checking`, `rework_pending`, `waiting`, `integrating`, `ready_to_merge`, `done`, `failed`, `cancelled`, `broken`. Clients choose the icon | `row mark "<m>" is not allowed; the marks are todo, blocked, ...` |
| `badge` | string | One line of at most 16 characters (`ROW_BADGE_MAX`), shown after the state, such as `#2` | `row badge must be a single line of at most 16 characters` |
| `parent` | string | The object one level up: a full id (`plan:repo/P-0001`) or a bare id that resolves as `show` resolves it. The kernel never invents one and does not check it exists | `row parent must be a non-empty object id` |
| `after` | list of strings | The siblings (the same `parent`) this object waits for, as row ids; clients draw it | `row after must be an array of non-empty object ids` |
| `waiting` | boolean | The object waits for a person although no run does (a proposed task); the row is drawn waiting | only `true` counts |

A row that fails is shown as an **error row** (`state` `error`, with the message) instead of failing the list: a throw, a Promise (`row returned a Promise; row must be synchronous`), a non-object (`row returned no row`), or a row that takes longer than 50 ms (`row took <n>ms; the limit is 50ms`, `DEFAULT_ROW_TIMEOUT_MS`). A row over the limit is measured once more and is an error only when both times are over, so a process the machine paused does not turn a fast row into an error.
The kernel adds `waiting` (a person wait is open on the object) and `running` (its run is working) to every row it serves.

See [Putting objects in levels](index.md#putting-objects-in-levels) for `parent` and [Putting objects under settings](index.md#putting-objects-under-settings) for `objectsUnderSettings`.

## Sections

`sections(object)` returns `{ id, title, live? }` entries. `live: true` says the content still grows; it must be a boolean (`section.live must be a boolean`).
Each entry's `id` is what a client passes back to `load`.

`load(ctx, object, sectionId, { cursor, after })` returns `SectionContent`:

| Field | Type | Meaning |
|---|---|---|
| `markdown` | string | The section's text. Required; anything else is `section "<s>" of "<id>": load must return { markdown, next? }` |
| `next` | string | The cursor of the next page; absent on the last |
| `pages` | list of `{ label, cursor? }` | A table of contents, one entry per page; the first page's cursor is absent. An entry without a text `label` is dropped |
| `mark` | string | An opaque position the *finished* content goes to. The kernel wraps it so it is used only for the section and object that made it, and a client passes it back as `after` |
| `tail` | string | The part that is still changing, as Markdown: always its **whole current text**, not what changed since the last read |
| `delta` | boolean | `true` when `markdown` holds only what follows the requested `after`. Leave it out when the answer is a whole page: the kernel then tells the client to replace instead of appending |

### The size cap, the timeout and the rate

| What | Value | When it takes effect | What happens |
|---|---|---|---|
| Time `load` may take | 10 seconds (`DEFAULT_LOAD_TIMEOUT_MS`) | Fixed; no setting changes it | The call is cut: `section "<s>" of "<id>" did not answer within 10000ms`, and `ctx.signal` is aborted so the code can stop |
| A throw in `load` | | Each read | `section "<s>" of "<id>" failed: <message>` |
| Size of one read | 256 KiB (`DEFAULT_SECTION_CAP_BYTES`) for `markdown` and `tail` together | Fixed | The finished `markdown` is shortened at a character boundary and ends with `[Truncated. See all of it with \`operad show <id> --section <s> --full\`.]`. The `tail` is never cut; when even the tail and the note do not fit, the read is refused with `section "<s>" of "<id>" is over the 262144-byte size cap; ...`. `--full` (the client's `full` option) lifts the cap |
| Announcing growth of a `live` section | At most once per object per 250 ms (`GROWTH_EVENT_INTERVAL_MS`) | Fixed | When a run about the object records a fact the kernel announces the object; announcements inside the window are held and the last one is sent when the window ends. An object's own stored change is always announced at once |
| An unknown section | | | `object "<id>" has no section "<s>"` |

### Reading only what is new: `mark`, `tail` and `after`

A section that grows (an agent's transcript) is read in two parts so a client does not fetch it all again: the *finished* content, which only grows at the end, and the *tail*, which still changes.

1. The first read has no `after`. The plugin returns the finished content as `markdown`, a `mark` that says where it ends, and the changing part as `tail`.
2. The client keeps the finished text and shows the tail after it. On the next read it sends the `mark` as `after`.
3. The plugin returns only the finished content that follows that mark as `markdown`, with `delta: true`, a new `mark` and the new whole `tail`. The client appends `markdown` to what it keeps and replaces the tail.
4. A plugin that does not implement `after` answers with the whole section and leaves `delta` out; the client replaces what it has. The kernel only reports a delta when the plugin said `delta: true` on a read that had an `after`.

An `after` that is not a mark the section gave is refused: `section "<s>" of "<id>": "after" is not a mark this section gave; read the section once without "after" first`; one made for another section or object says which: `the mark was made for section "<s>" of "<type>:<id>"; read this section without "after" first`.

### The history section

`history` is served by the kernel: one line per step the object's runs took, in words. A plugin that declares a section with that id is ignored and logged: `plugin "<name>": section "history" is reserved; the kernel serves it`. A type whose plugin is no longer loaded still shows `history`; any other section is refused: `the plugin that owns "<t>" is not loaded; only "history" is available`.
