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
