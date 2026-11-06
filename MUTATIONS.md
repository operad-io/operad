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

## TK0014 — kernel: pure decide, evolve and replay

| id | file | mutation | failing test |
|---|---|---|---|
| TK0014-M1 | `packages/engine/src/kernel/decide.ts` | made the visit limit unreachable (`visit > Number.MAX_SAFE_INTEGER`) | `decide: visits > ends the run when a step is entered past the default maxVisits` |
| TK0014-M2 | `packages/engine/src/kernel/decide.ts` | changed the crash-loop stop from `>=` to `>` | `decide: recover > requests a safe step again and stops after three recoveries` |
| TK0014-M3 | `packages/engine/src/kernel/decide.ts` | treated every step as replay-safe on recover | `decide: recover > interrupts an unsafe step and leaves it` |
| TK0014-M4 | `packages/engine/src/kernel/decide.ts` | skipped the declared-result check | `decide: step_result > turns an undeclared result into an interrupted failure` |
| TK0014-M5 | `packages/engine/src/kernel/decide.ts` | inverted the timed-wait comparison (`now > due` returned early) | `decide: tick > does nothing before a timed wait is due` |
| TK0014-M6 | `packages/engine/src/kernel/decide.ts` | removed the step_result effect id/status/step guard | `decide: step_result > ignores a result for an unknown effect` |
| TK0014-M7 | `packages/engine/src/kernel/state.ts` | recorded a completed result as still `outstanding` | `evolve: each fact kind > step_result records the result once` |
