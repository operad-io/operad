# Mutation records

| id | file | mutation | failing test |
|---|---|---|---|

## TK0013 — flow definition

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M1 | packages/engine/src/flow/validate.ts | inverted the missing-edge check (`!hasOwn` → `hasOwn`) | `validateFlow > names a result with no edge` |
| TK0013-M2 | packages/engine/src/flow/validate.ts | unknown plugin step type fell back to an empty result list instead of an error | `validateFlow > names an unknown plugin step type` |
| TK0013-M3 | packages/engine/src/flow/validate.ts | disabled the unreachable-step check | `validateFlow > names an unreachable step` |
| TK0013-M4 | packages/engine/src/flow/load.ts | dropped the file name from the import-error message | `loadFlow > names the file when a module throws on import` |
| TK0013-M5 | packages/engine/src/flow/define-flow.ts | removed the `wait_person` result-name check | `tsc -b`: `define-flow.test.ts(51,7): Unused '@ts-expect-error' directive` |
| TK0013-M6 | packages/engine/src/flow/validate.ts | disabled the duplicate-id check | `validateFlow > names duplicate step ids` |

## TK0013 — rework 2: plugin step names match exactly

| id | file | mutation | failing test |
|---|---|---|---|
| TK0013-M7 | packages/engine/src/flow/validate.ts | restored the fallback from `dev/command` to the unqualified `command` | `validateFlow > matches a plugin step type by its full name only` |

## TK0011 — jsonl log backend

| id | file | mutation | failing test |
|---|---|---|---|
| TK0011-M1 | `packages/engine/src/log/jsonl.ts` | `truncateTornLine` returned immediately, so a torn final line stayed on disk | `log backend: jsonl > a torn last line is cut off on open` |
| TK0011-M2 | `packages/engine/src/log/jsonl.ts` | `append` skipped the `expectedSeq` comparison | `log backend: jsonl > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0011-M3 | `packages/engine/src/log/secret.ts`, `packages/engine/src/log/json-value.ts` | `Secret.toJSON` returned the value and the JSON walker stopped rejecting `Secret` | `log backend: jsonl > a Secret never reaches the log` |
| TK0011-M4 | `packages/engine/src/log/jsonl.ts` | `recordInput` ignored the dedupe index | `log backend: jsonl > recordInput stores one record per (source, sourceKey)` |
| TK0011-M5 | `packages/engine/src/log/jsonl.ts` | `startRun` stopped refusing an active flow/object pair | `log backend: jsonl > startRun keeps one active run per flow and object` |
| TK0011-M6 | `packages/engine/src/log/jsonl.ts` | `ensureSchema` stopped refusing a newer `schema_version` | `log backend: jsonl > a newer schema_version is refused with a clear error` |

## TK0011 — review fixes

| id | file | mutation | failing test |
|---|---|---|---|
| TK0011-M7 | `packages/engine/src/log/jsonl.ts` | `#rebuildInputs` recorded the file size from `statSync` instead of the bytes it had read | `opening a store does not miss an input appended during the rebuild` |
| TK0011-M8 | `packages/engine/src/log/json-value.ts` | the JSON walker stopped rejecting a callable `toJSON` | `log backend: jsonl > a payload with a toJSON method is refused and writes nothing` |

## TK0012 — sqlite log backend

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M1 | `packages/engine/src/log/sqlite.ts` | `append` skipped the `expectedSeq` comparison | `log backend: sqlite > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0012-M2 | `packages/engine/src/log/sqlite.ts` | `startRun` stopped refusing an active flow/object pair; the partial unique index still rejected the insert | `log backend: sqlite > startRun keeps one active run per flow and object` |
| TK0012-M3 | `packages/engine/src/log/sqlite.ts` | `ensureSchema` stopped refusing a newer `schema_version` | `log backend: sqlite > a newer schema_version is refused with a clear error` |
| TK0012-M4 | `packages/engine/src/log/sqlite.ts` | `recordInput` used `INSERT OR REPLACE`, so a duplicate reported `duplicate: false` | `log backend: sqlite > recordInput stores one record per (source, sourceKey)` |
| TK0012-M5 | `packages/engine/src/log/sqlite.ts` | `read` stopped reporting a missing run | `log backend: sqlite > a run file deleted by hand makes read fail without touching other runs` |
| TK0012-M6 | `packages/engine/src/log/sqlite.ts` | `read` ordered facts newest first | `log backend: sqlite > append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch` |
| TK0012-M7 | `packages/engine/src/log/sqlite.ts` | open errors were rethrown unwrapped, so a read-only directory surfaced a raw SQLite error | `opening a store in a read-only directory fails with a clear error` |
| TK0012-M8 | `packages/engine/src/log/sqlite.ts` | `endRun` threw on an already-ended run | `log backend: sqlite > endRun is idempotent, unknown runs fail, and an ended run takes no facts` |

## TK0012 — rework 2: wait for the writer without polling

| id | file | mutation | failing test |
|---|---|---|---|
| TK0012-M9 | `packages/engine/src/log/sqlite.ts` | `setWalMode` rethrew `SQLITE_BUSY` instead of waiting for the other writer through the busy handler | `opening waits while another process holds the store` |

## TK0015 — plugin interface

| id | file | mutation | failing test |
|---|---|---|---|
| TK0015-M1 | packages/engine/src/plugin/registry.ts | removed the duplicate plugin-name check | `plugin registry validation > rejects two plugins with the same name` |
| TK0015-M2 | packages/engine/src/plugin/registry.ts | removed the try/catch around an action's `when` | `plugin registry validation > hides and logs an action whose when throws` |
| TK0015-M3 | packages/engine/src/plugin/registry.ts | called the flow loader without the loaded step types | `plugin registry > gives the flow loader the loaded step types` |
| TK0015-M4 | packages/engine/src/plugin/registry.ts | removed the `operadPlugin` version check | `plugin registry validation > rejects a plugin with an unsupported API version` |
| TK0015-M5 | packages/engine/src/plugin/registry.ts | disabled the short-command clash check between plugins | `plugin registry validation > rejects two plugins that declare the same short command` |
| TK0015-M6 | packages/engine/src/plugin/registry.ts | skipped the check that a step returned a declared result | `plugin registry validation > rejects a step that returns a result it did not declare` |
| TK0015-M7 | packages/engine/src/plugin/store.ts | stopped appending a fact when an object is put | `plugin registry > runs the test plugin's step, command and action end to end` |
