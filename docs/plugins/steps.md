---
description: Step types a plugin declares: every field, the step context, results, timeouts, limits and the errors.
---

# Steps

A step type is code a flow calls by name, `<plugin>/<name>`. It receives a context and the params the flow gave, and returns `{ result, data? }`.
The result picks the edge the flow follows next.

```ts
steps: [
  {
    name: "draft",
    results: ["ok", "failed"],
    timeoutSecs: 60,
    run: async (ctx, params) => {
      await ctx.store.put("note", "1", { text: "hello" }, "notes/draft");
      return { result: "ok", data: { words: 1 } };
    },
  },
],
```

## The fields

| Field | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `name` | string | required | Non-empty, unique in the plugin | At load | `steps: duplicate step "<s>"` |
| `results` | list of strings | required | Distinct, non-empty. Every result needs an edge in each flow that calls the step, and each edge names a declared result. A harness plugin's results must be [end results](harness.md#end-results) | At load | `steps[<i>]: results: must be an array`; `results[<j>]: must be a non-empty string`; `step "<s>": duplicate result "<r>"` |
| `run` | function | required | `(ctx, params) => { result, data? }`, sync or async | At load; code at each call | `steps[<i>]: run: must be a function` |
| `timeoutSecs` | number | not set: 300 seconds (`DEFAULT_STEP_TIMEOUT_MS`) | Positive and finite, in seconds. A step that runs an agent or a test suite sets it above its own limits | At load; a call that is already running keeps the limit it started with | `timeoutSecs: must be a positive number of seconds` |
| `resumable` | boolean | not set: the step's questions keep the `onTimeout` they ask with (see [Asking](asking.md)) | `true` when the step can run again after a question left it, taking `resumeSession` and `askAnswer` in its params; `false` forces every question to `onTimeout: "reject_once"` | At load | `resumable: must be true or false` |
| `grants` | boolean | not set | `false` when the step cannot let one call through and no other; `ctx.ask` then refuses a question that offers a one-time permission | At load | `grants: must be true or false` |
| `calls` | list of strings | not set | Distinct `plugin/step` names the step starts with `ctx.runStep`. A run does not start while one is not loaded | At load | `calls[<i>]: must be a step name like "plugin/step"`; `calls[<i>]: duplicate "<c>"` |
| `callsNamedByData` | boolean | not set | `true` when settings or an object name the steps called, so `calls` cannot list them. A call to one that is not loaded fails where it is made | At load | `callsNamedByData: must be true or false` |
| `enforces` | list of strings | not set | Access-profile fields this step applies, such as `denyPaths` | At load | `enforces: duplicate field "<f>"` |
| `limit` | `{ key, concurrent }` | not set | Both functions of `(params, settings)`. `key` returns the shared thing (a model, an account) or `undefined` for no limit; `concurrent` returns how many calls under one key may run at once in the operad home | At load; the functions at each call | `step "<s>": limit: unknown field "<f>"; expected key and concurrent`; `limit: key: must be a function of (params, settings)` |

A step whose `run` returns anything but `{ result, data? }` fails with `step "<use>": run: must return { result, data? }`.
A result that is not declared fails with `step "<use>": result "<r>" is not one of "<a>", "<b>"`.
`data`, when given, must be an object: `step "<use>": data: must be an object`.
Facts hold data and paths, never process output: write the output to `ctx.logger` and keep its path in `data`.

## When a step ends without a result

| What happened | How the step ends |
|---|---|
| `run` throws | With the result `failed` when the step declares it, otherwise `interrupted`; the message goes into the history. |
| The timeout passes (`timeoutSecs`, or five minutes) | The same as a throw: `failed` when the step declares it, otherwise `interrupted`; the history says `the step took longer than <ms> ms`. A step that declares neither is named `failed` and the kernel turns it into an interrupted step. |
| The process stops while the step runs | On restart a step whose flow entry says `replay: "safe"` runs again; one that says `"unsafe"` takes its `interrupted` edge (an unsafe step needs that edge). A step that keeps crashing three times (`CRASH_LOOP_LIMIT`) stops the run and asks a person `retry` or `cancel`. |
| The run is cancelled | The step's `signal` is aborted. |

Whatever a step started through the platform is stopped when the step ends: see [the step marker](platform.md#what-a-step-leaves-behind).

## The step context

A step's context has every field of [the base context](define-plugin.md#the-context-every-hook-gets) and:

| Field | Type | What it holds |
|---|---|---|
| `runId` | string | The run the step belongs to. |
| `object` | `{ type, id, data } \| undefined` | The object the run is about. |
| `params` | JSON | The fixed JSON the flow gave this step; `null` when none. |
| `access` | JSON | The run's access profile, opaque to the kernel; `null` when none. |
| `trigger` | `TriggerView \| undefined` | The event that started the run: `source`, `key`, `type`, `hops`, and paths to its `summary` and `data` text, never the text. |
| `emit(event)` | function | Sends an [event](events.md#a-step-sends-an-event); its type must begin with `<plugin>.`. |
| `ask(request)` | function | [Asks a person](asking.md) and waits while the step lives. |
| `useGrant(waitId)` | function | Uses up a one-time permission an answer gave; call it before the call it covers. |
| `receiver` | function \| undefined | Takes each log line a harness step writes, when the caller gave one. |
| `queued(key, ahead?)` | function \| undefined | Tells the kernel the step waits for a place the plugin manages itself under `key`; the running view shows it queued. Call the function it returns when the wait is over. |
| `stepLoaded(use)` | function \| undefined | Whether a plugin that declares this step is loaded now. |
| `harnessModels(name)`, `harnessEfforts(name)` | functions \| undefined | The models and efforts a loaded harness plugin declares. |
| `runStep(use, params, options)` | function \| undefined | Runs another loaded step in this run. A direct call to a step's `run` has no host and leaves it undefined. |

`runStep` checks `calls`: under `NODE_ENV=test` a call that the step did not declare in `calls` (and is not a harness step, and the step does not set `callsNamedByData`) fails with `step "<use>": calls "<nested>" without declaring it in calls`; in production it runs.

## Limits

A step type with `limit` waits for a place when `concurrent` runs under the same key are going: the running view shows the run queued, and the place is held until the step has a result.
The places are rebuilt from the facts of the runs, so a restart loses none.
A harness step that a `pool` step starts has its places counted the same way; see [Harness plugins and pool workers](harness.md#pool-workers).

## Flows call steps

A flow names a step as `use: "<plugin>/<name>"` and an unknown name is refused when the flow is checked: `flow "<f>": step "<s>": params.use: unknown plugin step type "<use>"`.
See [Flows](flows.md).
