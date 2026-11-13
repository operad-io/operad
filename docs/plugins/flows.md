---
description: defineFlow and the four basic steps: every param, every edge and the errors a flow is refused with.
---

# Flows

A flow is data: an entry step and a list of steps, and for each step where each result leads.
`defineFlow({ name, entry, steps, maxVisits? })` returns the value unchanged and has the compiler check the result names in `next`: a name that is not one of a `wait_person` step's choices is a type error.
`validateFlow(flow, stepTypes)` is what the registry runs; a flow that fails is refused with a `FlowError` naming the flow, the step and the field.

## The flow

| Field | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `name` | string | required | Non-empty; unique in its plugin | At load | `flow: name: must be a non-empty string`; `flows: duplicate flow "<f>"` |
| `entry` | string | required | The `id` of one of the steps | At load | `flow "<f>": entry: "<id>" is not a step` |
| `steps` | list | required | See [the four steps](#the-four-steps) | At load | `flow "<f>": steps: must be an array`; `step "<id>": id: duplicate step id "<id>"`; `id: "end" is reserved` |
| `maxVisits` | integer | `10` (`DEFAULT_MAX_VISITS`) | `1` or more: how many times a run may enter the same step | At load; a run keeps its flow | `flow "<f>": maxVisits: must be a positive integer`. A run that enters a step once more than the limit ends `failed` with the reason `visit_limit` |

Every step must be reachable from `entry` (`step "<id>": id: step is unreachable from entry "<entry>"`), and cycles are allowed.
A flow's `next` names a step id, or `"end"` to finish.

## The four steps

Each step has `id`, `kind`, `params`, `replay` (`"safe"` or `"unsafe"`) and `next`, a map from each result to a step id.
`next` must hold an edge for every result the step can produce and no other: `step "<id>": next: no edge for result "<r>"` and `next.<r>: "<r>" is not a result of this step`.

| `kind` | `params` | Results (the keys of `next`) |
|---|---|---|
| `plugin` | `{ use: "<plugin>/<step>", params: <JSON> }`; `params` must be present, `{}` when the step takes none | The step type's `results`, plus `interrupted` when `replay` is `"unsafe"`. An edge `waiting` must lead to a `wait_person` step |
| `wait_person` | `{ prompt, choices, lateChoices?, note? }` | Each of `choices`, each of `lateChoices`, and `interrupted` |
| `wait` | `{ afterSecs }` or `{ check: "<plugin>/<step>", params? }`; exactly one of the two | `ready`, `interrupted` |
| `end` | `{ status: "done" \| "failed" \| "cancelled" }` | none: the step has no `next` |

| Param | Type | Allowed values | A wrong value |
|---|---|---|---|
| `prompt` | string | Non-empty | `params.prompt: must be a non-empty string` |
| `choices` | list of strings | The answers offered; each is a result of the step, so each needs an edge in `next` | `params.choices: must be an array of strings` |
| `lateChoices` | list of strings | Answers a timed-out step may hand over that this wait does not offer by itself; each needs an edge and is shown only when the step that asked hands one over | `params.lateChoices: must be an array of strings` |
| `note` | string | Non-empty. Shown when the step that led here was interrupted; `{step}` names that step | `params.note: must be a non-empty string` |
| `afterSecs` | number | Zero or more, finite | `params.afterSecs: must be zero or more seconds` |
| `check` | string | A loaded step type. The runner calls it on each pass; the wait ends when it returns the result `ready` (or `interrupted`) and any other result keeps waiting | `params.check: unknown plugin step type "<c>"` |
| `status` | string | `done`, `failed`, `cancelled` | `params.status: must be "done", "failed" or "cancelled"` |

Other messages: `step "<id>": kind: unknown step kind "<k>"`, `step "<id>": replay: must be "safe" or "unsafe"`, `step "<id>": params: must be an object`, `step "<id>": next.<r>: "<t>" is not a step`.

## `replay`

`replay` says what a restart may do with a step that was running when the process stopped.
`"safe"`: run it again. `"unsafe"`: do not; take the `interrupted` edge, which the flow must have (the kernel adds `interrupted` to the results of an unsafe `plugin` step so the check demands the edge).

## A wait for a person

A `wait_person` step puts one item in [pending](pending.md) with its `prompt` and `choices`.
An answer takes the edge its choice names. Nothing in the process holds the wait: an answer can arrive after a restart.
A step that [asks a question](asking.md) and runs out of grace ends `waiting` and hands its question to the `wait_person` step its `waiting` edge names.

## Declared by a plugin, loaded from a file

A plugin's `flows` list holds the flows it ships. A flow in a module of its own, whose default export is a `defineFlow` value, is imported with `loadFlow(path)` and checked with `validateFlow`.
`END` (`"end"`) is the reserved id an edge points at to finish a flow.
