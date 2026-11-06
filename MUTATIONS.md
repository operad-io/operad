# Mutation records

| id | file | mutation | failing test |
|---|---|---|---|

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

