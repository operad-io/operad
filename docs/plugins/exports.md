---
description: Every export of @operad-io/engine, @operad-io/engine/platform and @operad-io/engine/testing that a plugin uses, with the page that explains it.
---

# Exports

A plugin imports from three entry points:

| Entry point | What it holds |
|---|---|
| `@operad-io/engine` | `definePlugin`, `defineFlow`, the plugin and flow types and the small helpers below |
| `@operad-io/engine/platform` | Process groups, file locks, directory watches, sqlite open settings: see [the platform module](platform.md) |
| `@operad-io/engine/testing` | `runFlow` and the other test helpers: see [Testing a plugin](testing.md) |

Types (`StepContext`, `ActionTypeDefinition`, `ObjectRow`, ...) are exported too and listed on [Types](types.md). A test (`scripts/test/plugin-docs.test.ts`) compares the values and types these entry points export with the first column of the tables under `docs/plugins`: a name with no entry fails, unless `scripts/test/plugin-docs.allow.json` lists it with the reason it is internal to the host (the command line, `serve`, the HTTP server, the log backends). Names a plugin package imports can never be listed there.

## Declaring a plugin

| Export | What it is | Page |
|---|---|---|
| `definePlugin` | Declares a plugin and adds `operadPlugin: 1` | [definePlugin](define-plugin.md) |
| `OPERAD_PLUGIN_VERSION` | `1`: the plugin API version a module declares | [definePlugin](define-plugin.md#the-fields) |
| `PLUGIN_API_VERSION` | `"1.0.0"`: the API version as a semver version, for `requires.api` | [`requires`](define-plugin.md#requires) |
| `ENGINE_VERSION` | The engine's version, `"0.0.0"` | [definePlugin](define-plugin.md) |
| `defineFlow` | Declares a flow and checks its result names at compile time | [Flows](flows.md) |
| `validateFlow` | Checks a flow against the step types; throws `FlowError` | [Flows](flows.md) |
| `loadFlow` | Imports a module whose default export is a flow and validates it | [Flows](flows.md#declared-by-a-plugin-loaded-from-a-file) |
| `END` | `"end"`: the reserved step id an edge points at to finish a flow | [Flows](flows.md) |
| `DEFAULT_MAX_VISITS` | `10`: how many times a run may enter one step | [Flows](flows.md#the-flow) |
| `CRASH_LOOP_LIMIT` | `3`: recoveries without a result before a person is asked `retry` or `cancel` | [Steps](steps.md#when-a-step-ends-without-a-result) |
| `splitActionName` | Splits `<plugin>:<action>` or `<plugin>/<action>` | [Actions](actions.md) |
| `PluginRegistry` | The registry a host builds from plugin definitions. A plugin's test may build one (`new PluginRegistry([definition], { store })`) to call `runAction`, `viewsFor` or `runCommand` | [Testing](testing.md#testing-the-pieces) |
| `loadPlugin` | `loadPlugin(module, home)`: imports a plugin module and returns its default export; a path gets a fresh module instance | [Settings](settings.md#the-entry-in-configjson) |
| `objectKey` | `objectKey(ref)`: `<type>:<id>`, or `flow` for a run without an object | [Events](events.md#the-event) |
| `parseObjectKey` | The `{ type, id }` of a key, or `undefined` for a key that names no object (`flow:<plugin>/<flow>`) | [Events](events.md#the-event) |

## Errors

| Export | Thrown when | Page |
|---|---|---|
| `PluginError` | A declaration is malformed, a step returns the wrong shape, a plugin cannot be used. The message names the plugin and field | [definePlugin](define-plugin.md#refused-declarations) |
| `AccessError` | A run's access profile asks for a field no step of its flow applies (`enforces`); has `field` | [definePlugin](define-plugin.md#the-fields) |
| `AskTimeoutError` | The grace of a question passed with `onTimeout: "waiting"` (`nobody answered "<prompt>" in time`); a step that lets it escape ends with the result `waiting` | [Asking](asking.md) |
| `StartRefusedError` | A run cannot start because a step it needs is not loaded | [Events](events.md#rules) |
| `StepNotLoadedError` | A step was called that no loaded plugin declares (its plugin is disabled or failed to load): `step "<use>": no loaded plugin declares it`; has `kind` `step_not_loaded` and `use` | [Steps](steps.md#flows-call-steps) |
| `messageOf` | `messageOf(error)`: the message of anything thrown, as text | [definePlugin](define-plugin.md#refused-declarations) |
| `FlowError` | A flow is not usable; the message names the flow, step and field | [Flows](flows.md) |
| `ActionArgsError` | A person's values do not fit the schema | [Actions](actions.md#the-args-schema) |
| `CursorError` | A cursor is not one this store made for this call | [Storage](storage.md#filters-pages-and-cursors) |
| `WhereError` | A `where` filter names a field the type did not declare in `index` | [Storage](storage.md#filters-pages-and-cursors) |
| `StateError` | An answer or a cancel does not fit the run's state (`run <id> is not waiting for a person`) | [Pending](pending.md#a-wait-for-a-person-in-a-flow) |
| `ViewError` | A list, a section or an action call is refused; its `kind` is one of `not-found`, `ambiguous`, `no-views`, `section`, `timeout`, `action`, `not-available`, `unavailable`, `note`, `confirm`, `args`, `where`, `filter`, `cursor` | [Views](views.md), [Actions](actions.md#order-of-the-checks) |
| `ActiveRunError` | `flow "<f>" already has an active run for object "<o>" (<runId>)`; has `flow`, `object`, `runId` | [Events](events.md#rules) |
| `CronError` | A cron expression is not valid | [Events](events.md#a-source-plugin) |
| `SecretSerializationError` | A `Secret` is serialised to JSON | [Settings](settings.md#secrets) |
| `TriggerError` | A rule is malformed; the message names the file, the rule's index and the field | [Events](events.md#rules) |
| `SettingsError` | A settings call is refused and nothing was written; its `kind` is `not-found`, `args`, `not-available`, `confirm` or `ambiguous` | [Settings](settings.md#editing-a-setting) |
| `UploadMissingError` | An upload reference names no upload: never made, already used or expired | [Actions](actions.md#the-args-schema) |
| `UploadTooLargeError` | An upload is larger than `MAX_UPLOAD_BYTES`; has `limit` | [Actions](actions.md#the-args-schema) |

## Steps, results and harnesses

| Export | What it is | Page |
|---|---|---|
| `END_RESULTS` | `done`, `nothing`, `failed`, `needs_decision`, `waiting`, `interrupted`: the results a harness step may end with | [Harness plugins](harness.md#end-results) |
| `isEndResult` | `true` for one of them | [Harness plugins](harness.md#end-results) |
| `COST_QUALITIES` | `exact`, `estimated`, `incomplete` | [Harness plugins](harness.md#the-step) |
| `validateUsage` | Checks a value against `Usage`; a refusal names the first wrong field | [Harness plugins](harness.md#the-step) |
| `readUsage` | Reads a step's usage back from its data | [Harness plugins](harness.md#the-step) |
| `DEFAULT_STEP_TIMEOUT_MS` | `300000`: the step timeout when a step sets no `timeoutSecs` | [Steps](steps.md#the-fields) |
| `MAX_ASK_GRACE_SECS` | `2147483`: the longest grace a question may have | [Asking](asking.md) |
| `DEFAULT_ASK_GRACE_SECS` | `600`: the default of `ask.graceSecs` | [Asking](asking.md) |
| `askWaitId` | `askWaitId(runId, stepRunId, n)`: the stable id of a question, `<run>:<step run>:<n>` | [Asking](asking.md) |
| `paramsObject` | `paramsObject(params, at)`: a step's params as an object, or `<at>: params: must be an object` | [Steps](steps.md#the-step-context) |

## Views, rows and sections

| Export | What it is | Page |
|---|---|---|
| `ROW_MARKS` | The marks a row may carry | [Views](views.md#the-row) |
| `ROW_BADGE_MAX` | `16`: the longest badge, in characters | [Views](views.md#the-row) |
| `HISTORY_SECTION` | `"history"`: the section the kernel adds to every object | [Views](views.md) |
| `DEFAULT_ROW_TIMEOUT_MS` | `50`: the time a `row` may take | [Views](views.md#the-row) |
| `DEFAULT_LOAD_TIMEOUT_MS` | `10000`: the time a section's `load` may take | [Views](views.md#the-size-cap-the-timeout-and-the-rate) |
| `DEFAULT_SECTION_CAP_BYTES` | `262144`: the size of one section read | [Views](views.md#the-size-cap-the-timeout-and-the-rate) |
| `GROWTH_EVENT_INTERVAL_MS` | `250`: how often one object's live growth is announced | [Views](views.md#the-size-cap-the-timeout-and-the-rate) |
| `ALL_FILTER` | `"all"`: the filter the kernel adds to a type | [Views](views.md#filters) |
| `typeFilters` | The filters of a type, with `all` after the default | [Views](views.md#filters) |
| `filterShows` | Whether a filter shows a row in a state | [Views](views.md#filters) |
| `displayNameOf` | The name a type shows in a client: `task` becomes `Task` | [Views](views.md#object-types) |

## Actions and files

| Export | What it is | Page |
|---|---|---|
| `isActionOutcome` | `true` for `{ text, opens }` | [Actions](actions.md#the-fields) |
| `normalizeActionArgs` | Checks a schema at load | [Actions](actions.md#the-args-schema) |
| `validateActionArgs` | Checks a person's values against a schema | [Actions](actions.md#the-args-schema) |
| `noteProperty` | The `role: "note"` property of a schema | [Actions](actions.md#the-args-schema) |
| `fileProperties` | The `format: "file"` properties of a schema | [Actions](actions.md#the-args-schema) |
| `FILE_FORMAT` | `"file"` | [Actions](actions.md#the-args-schema) |
| `MAX_UPLOAD_BYTES` | 20 MiB: the largest upload | [Actions](actions.md#the-args-schema) |
| `UPLOAD_TTL_MS` | One hour: how long an unused upload stays | [Actions](actions.md#the-args-schema) |
| `attachmentDir` | `attachmentDir(home, type, id)`: where an object's attachments are stored | [Actions](actions.md#the-args-schema) |
| `attachmentUrl` | The `/v1/attachments/...` path of a stored file, or `undefined` outside the attachment directories | [Actions](actions.md#the-args-schema) |
| `findAttachment` | The stored file a `/v1/attachments/<rel>` request names | [Actions](actions.md#the-args-schema) |
| `safeFileName` | A file name that is safe as one path segment | [Actions](actions.md#the-args-schema) |
| `storedType` | The type the upload of a stored file gave | [Actions](actions.md#the-args-schema) |

## Storage, settings and secrets

| Export | What it is | Page |
|---|---|---|
| `MemoryPluginStore` | The in-process store, for tests and one-shot use | [Storage](storage.md) |
| `SqlitePluginStore` | The store backed by one SQLite file | [Storage](storage.md) |
| `openPluginStore` | Opens the store a home uses | [Storage](storage.md) |
| `OBJECT_CHANGE_FACT` | `"object.changed"`: the type of a fact `put` writes | [Storage](storage.md#reading-changes) |
| `foldObjectFacts` | `foldObjectFacts(facts, start?)`: yields the whole object after each version fact, and returns the final value | [Storage](storage.md#reading-changes) |
| `objectValueAfter` | The whole object after one fact, or `undefined` for an appended fact | [Storage](storage.md#reading-changes) |
| `diffObject` | The changed fields and removed names from one object value to the next, or `undefined` when nothing changed | [Storage](storage.md#reading-changes) |
| `applyObjectChange` | The whole object after applying one change | [Storage](storage.md#reading-changes) |
| `objectChangeOf` | The change a change fact's data holds | [Storage](storage.md#reading-changes) |
| `isObjectFact` | `true` for a fact that records a version of its object | [Storage](storage.md#reading-changes) |
| `DEFAULT_PAGE_LIMIT` | `100` | [Storage](storage.md#filters-pages-and-cursors) |
| `MAX_PAGE_LIMIT` | `1000` | [Storage](storage.md#filters-pages-and-cursors) |
| `pageLimit` | The limit a page uses | [Storage](storage.md#filters-pages-and-cursors) |
| `encodeCursor` | Makes an opaque cursor | [Storage](storage.md#filters-pages-and-cursors) |
| `decodeCursor` | Reads one, or throws `CursorError` | [Storage](storage.md#filters-pages-and-cursors) |
| `assertWhere` | Refuses a filter on a field not in `index` | [Storage](storage.md#filters-pages-and-cursors) |
| `canonical` | A stable text form of a JSON value | [Storage](storage.md#filters-pages-and-cursors) |
| `whereFingerprint` | The fingerprint a list cursor carries | [Storage](storage.md#filters-pages-and-cursors) |
| `createPluginLogger` | A logger that appends to a file under the store | [Storage](storage.md#the-logger) |
| `prepareSettings` | Validates a settings section and fills the defaults | [Settings](settings.md#the-schema) |
| `Secret` | A value that must never reach the log | [Settings](settings.md#secrets) |
| `secret` | `secret(value)`: makes a `Secret` | [Settings](settings.md#secrets) |
| `FileSecretStore` | The class behind `ctx.secrets` | [Settings](settings.md#secrets) |
| `secretsDirectory` | `<home>/secrets` | [Settings](settings.md#secrets) |
| `secretsPathFor` | The file one plugin's secrets live in | [Settings](settings.md#secrets) |
| `GLOBAL_SCOPE` | `"global"`: the scope of a setting in `config.json` | [Settings](settings.md#editing-a-setting) |
| `notificationKey` | `notificationKey(runId, waitId)`: `notify:<runId>:<waitId>`, the key of one notification | [Pending](pending.md#notifications-and-channels) |
| `NOTIFIED_FACT` | `"notified"`: the kind of the global fact a notification is recorded as | [Pending](pending.md#notifications-and-channels) |
| `NOTIFY_TIMEOUT_MS` | `30000`: how long the notify command may run | [Pending](pending.md#notifications-and-channels) |
| `keysPathFor` | The path of `keys.json` | [Settings](settings.md#key-bindings) |
| `readKeysFile` | Reads it | [Settings](settings.md#key-bindings) |
| `defaultOperadHome` | `$OPERAD_HOME`, or `~/.operad` | [Settings](settings.md#the-entry-in-configjson) |
| `configPath` | `<home>/config.json` | [Settings](settings.md#the-entry-in-configjson) |
| `isRangeSyntax` | Whether a version range is one of `^`, `~`, `>=` or exact | [`requires`](define-plugin.md#requires) |
| `satisfiesRange` | Whether a version satisfies a range | [`requires`](define-plugin.md#requires) |

## Events and schedules

| Export | What it is | Page |
|---|---|---|
| `MAX_TRIGGER_HOPS` | `8`: how deep a chain of events is followed | [Events](events.md#the-event) |
| `parseTriggerRules` | Checks a parsed list of rules | [Events](events.md#rules) |
| `mergeTriggerRules` | Merges the person's rules over a plugin's: the same source and type replaces | [Events](events.md#rules) |
| `parseCron` | Parses a five-field cron expression | [Events](events.md#a-source-plugin) |
| `cronMatches` | Whether a time matches a schedule | [Events](events.md#a-source-plugin) |
| `cronMinutesBetween` | The matching minutes in a span | [Events](events.md#a-source-plugin) |
| `latestCronMinute` | The latest matching minute up to a time | [Events](events.md#a-source-plugin) |
| `minuteStart` | The start of the minute of a time | [Events](events.md#a-source-plugin) |

## Small helpers

| Export | What it is | Page |
|---|---|---|
| `isRecord` | `true` for a plain object that is not an array | [Rules](rules.md#code) |
| `stringList` | The strings of an array value; anything that is not an array gives an empty list | [Rules](rules.md#code) |
| `oneLine` | `oneLine(text, limit?, trimCut?)`: whitespace collapsed to one line, cut with `…` at `limit` | [Rules](rules.md#code) |
| `requireName` | `requireName(value, field)` throws `<field>: must be a non-empty string` for an empty or blank value | [Rules](rules.md#code) |
| `repeatEvery` | `repeatEvery(ms, callback)`: calls back every `ms` until the returned function is called; it never keeps the process alive | [Platform](platform.md#directory-watches) |
| `sleepUntilAborted` | `sleepUntilAborted(ms, signal?)`: waits `ms`, but an abort of the signal ends the wait at once | [Rules](rules.md#tests) |
| `writeFileAtomic` | Writes a file through a temporary file in the same directory and a rename, so a crash leaves the old file whole | [Settings](settings.md#editing-a-setting) |
