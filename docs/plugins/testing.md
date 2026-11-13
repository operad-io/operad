---
description: Testing a plugin with @operad-io/engine/testing: every export, option and field of a run, and what a test world does and does not load.
---

# Testing a plugin

`@operad-io/engine/testing` runs a plugin's flows with the engine's own runner and kernel, driven by the same pass `serve` makes: a call records what a person or a source would, then the pass runs until nothing changes.
Each world is a scratch directory with a log, a store, a registry holding **the plugin under test and no other**, and the kernel. Nothing is started that outlives the test; `cleanup()` removes every scratch directory.
[Writing a plugin](index.md#testing-it) shows the helpers in use. Every test runs with `bun test --timeout 30000 <file>`.

Because only the plugin under test is loaded, a flow that calls a step of another plugin (`shell/command`, say) is refused when the plugin loads. Test such a flow by giving the plugin a stand-in step of that name in the test, or test the steps one at a time with `inProcess: true`.

## The exports

| Export | Signature | What it does |
|---|---|---|
| `runFlow` | `runFlow(plugin, flow, options?) => Promise<FlowRun>` | Starts `flow` (a name or a definition) in a world of its own and runs it to its end or first wait. Throws `the plugin has no flow "<name>"` for an unknown flow, and `the flow "<name>" did not start (<kind>)` when the kernel refused to start it |
| `answer` | `answer(run, waitId, choice, note?) => Promise<FlowRun>` | Records the answer to the wait the run is in, as the command line does, then runs the world on. `run <id> is not waiting for a person`; `run <id>: the wait "<w>" is not the one it is in ("<current>")`; a choice the wait does not offer is refused with the engine's message |
| `resume` | `resume(run) => Promise<FlowRun>` | Runs the world on after something outside it changed, such as the clock passing a time wait |
| `emit` | `emit(plugin, source, type, data?, options?) => Promise<EmitResult>` | Sends one event through the plugin's rules in a world of its own, as a source plugin would |
| `testWorld` | `testWorld(plugin, options?) => Promise<TestWorld>` | One world kept across calls, for a repeated event key or a run that ends and starts the next |
| `fakeClock` | `fakeClock(start = 0) => FakeClock` | A clock the test moves |
| `memoryStore` | `memoryStore() => PluginStore` | An empty in-memory store, for `inProcess` runs that start from objects the test seeds |
| `cleanup` | `cleanup() => Promise<void>` | Removes every scratch directory the package made. Call it in `afterAll` |

## The plugin under test

`plugin` is `PluginUnderTest`: the **path or package name of the module**, or its definition.

| Given as | Steps run | Needs |
|---|---|---|
| A path or name | In a worker thread that loads the module afresh, against a real SQLite store, as under `serve` | Nothing |
| A definition (the value of `definePlugin`) | In the test's own process against an in-memory store | `inProcess: true`; without it: `a plugin given as a definition can only run in this process: pass its module path to run its steps in a worker as serve does, or set inProcess: true` |

Prefer the path: a step that keeps state in a module variable, or returns a value a worker cannot hand back, behaves in the test as it does under `serve`. `inProcess: true` is faster and is the only way to seed a `memoryStore()` or test a plugin defined inside the test file; it is not isolated, so a test can pass in process and fail under `serve`.

## Options

`runFlow` takes `RunFlowOptions`; `testWorld` and `emit` take the world options.

| Option | Type | Default | Meaning | A wrong value |
|---|---|---|---|---|
| `settings` | record | `{}` | The plugin's `config.json` section (`ctx.settings`), validated against its schema | The plugin is refused and the call throws the refusal message |
| `secrets` | record of strings | none | The plugin's secrets (`ctx.secrets`), written before the run | |
| `clock` | `FakeClock` | the real clock | Step timeouts and time waits follow it | |
| `inProcess` | boolean | `false` | Run steps in this process against an in-memory store | |
| `store` | `PluginStore` | `memoryStore()` | Objects to start from | `a store of your own needs inProcess: true; a worker opens its own` |
| `object` | `{ type, id }` | `<first object type>:1` | The object the run is about (`runFlow` only) | |
| `params` | JSON | none | The fixed JSON the flow starts with (`ctx.params`) (`runFlow` only) | |
| `access` | JSON | none | The access profile (`ctx.access`) (`runFlow` only) | |

`emit` options: `key` (the idempotency key, a fresh one for each event of a world by default), `object` (`<type>:<id>`) and `summary`.

## What a run is

`FlowRun` is a snapshot, taken when the call returned:

| Field | Type | What it holds |
|---|---|---|
| `runId` | string | The run's id |
| `flow` | string | The flow's name |
| `status` | `"ended"`, `"waiting_person"` or `"blocked"` | `blocked` means nothing more can happen until something outside the world changes (a clock passes a time, an answer arrives) |
| `end` | `"done"`, `"failed"`, `"cancelled"` or `undefined` | How it ended |
| `wait` | `{ id, prompt, choices } \| undefined` | The open person wait |
| `facts` | list | Everything the run recorded, in order |
| `history` | list of strings | One line per step, as `operad history` prints it |
| `store` | `PluginStore` | The plugin's objects |

`EmitResult` is `{ started, result, run }`: `started` is `true` when a rule matched and the event was not a repeat, `result` the kernel's `TriggerResult` (`kind`, `inputId`, `duplicate`, `flow?`, `object?`, `reason?`), `run` the run it started taken to its end or first wait.
`TestWorld` has `store`, `runFlow(flow, { object?, params?, access? })`, `emit(source, type, data?, options?)`, `runs()` (every run, in the order they started) and `close()`.
A world that keeps changing after 200 passes throws `the runs were still changing after 200 passes`: a loop, not a test.

## `fakeClock`

`fakeClock(start = 0)` returns a `FakeClock`, which is also a platform `Clock`:

| Member | What it does |
|---|---|
| `now()` | The time now, in milliseconds |
| `advance(ms)` | Moves time forward and fires every timer that falls due, in order of due time; a timer set by a handler fires too when it falls inside the same advance |
| `pending` | How many timers are set and not yet fired or cleared |
| `whenTimer()` | Resolves once at least one timer is set: wait for it instead of sleeping |
| `setTimeout`, `clearTimeout`, `sleep` | The `Clock` the platform's helpers read |

```ts
const clock = fakeClock();
const running = runFlow(slow, "stuck", { clock });
await clock.whenTimer();       // the step started and its timeout is set
clock.advance(5 * 60 * 1000);  // the default step timeout
const run = await running;
```

## Testing the pieces

| What | How |
|---|---|
| A step | `runFlow` with a one-step flow; read `run.facts` and `run.store` |
| A person wait | `run.wait`, then `answer(run, run.wait.id, "<choice>")` |
| A time wait | `runFlow(..., { clock })`, `clock.advance(ms)`, `resume(run)` |
| A rule | `emit(plugin, "<source>", "<type>")`; `sent.started` and `sent.run` |
| A repeated event | `testWorld`, the same `key` twice: the second has `started: false` |
| A crash | Kill a real child process; do not simulate one |
| An action, a view or a command | Build the registry with `new PluginRegistry([definition], { store: memoryStore() })` and call `runAction`, `viewsFor(type)`, `runCommand` |

Wait for the event, never sleep for it. A test that needs time takes an injected clock.
