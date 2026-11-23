---
description: Harness plugins (claude, codex, pi, radian) and pool workers: the step contract, end results, params, resumable questions, models and efforts.
---

# Harness plugins and pool workers

A **harness plugin** runs a coding agent. Four ship with operad: `claude`, `codex`, `pi` and `radian` (modules `@operad-io/harness-<name>`). Each is a `definePlugin` with `kind: "harness"` and one step type, `agent`, so a flow written against one works with the next. The kernel never runs an agent itself.
A **pool** (`pool`, kind `stage`) is a plugin whose one step, `pool/agent`, picks a worker, waits for room and runs that worker's harness step.
The keys a person sets for each plugin are in [config.json](../user/config.md#plugin-settings); this page is for the author of a harness or of a flow that calls one.

## End results

A harness step may end only in the standard end results. A harness plugin that declares another result is refused: `plugin "<name>": step "<s>": result "<r>" is not an end result; a harness step ends in done, nothing, failed, needs_decision, waiting, interrupted`.

| Result (`END_RESULTS`) | Meaning |
|---|---|
| `done` | The agent finished its work |
| `nothing` | In the list for a harness whose run changes nothing; no shipped harness ends with it |
| `failed` | It did not finish; `data.reason` and `data.message` say why |
| `needs_decision` | In the list for a harness that stops for a person's decision; no shipped harness ends with it |
| `waiting` | A question was not answered within its grace; see [Asking](asking.md). Only a harness that asks declares it (`claude`, `codex` and `pi` do; `radian` does not) |
| `interrupted` | A crash, a timeout or a cancel stopped it |

`isEndResult(value)` tests a name. The shipped harnesses declare `["done", "failed", "interrupted", "waiting"]` (`radian`: without `waiting`).

## The step

| Field | `claude`, `codex`, `pi` | `radian` | Why |
|---|---|---|---|
| `name` | `agent` | `agent` | A flow calls `<harness>/agent` |
| `resumable` | `true` | `true` | A question's answer comes back as `resumeSession` and `askAnswer` in the params |
| `grants` | not set | `false` | `radian` cannot enforce a one-time permission, so `ctx.ask` refuses a question that offers one |
| `enforces` | `level`, `denyPaths`, `denyCommands`, `askCommands`, `askPaths`, `readPaths`, `alwaysAllow` (`codex`: without `level`) | none | The access-profile fields the harness applies in the agent's permission hook |
| `timeoutSecs` | 28800 (eight hours) | the step default | A step that runs an agent sets its limit above its own wall time |
| `limit` | by model: `settings.concurrency[<model>]` | | At most that many runs of one model at once in the operad home (`modelLimit(harness, modelOf)` of `@operad-io/harness-process` builds it) |

The params of every `agent` step (`AgentStepParams`):

| Param | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | required | What the agent is asked |
| `cwd` | string | required | Where it works |
| `args` | list of strings | none | Extra arguments for the agent's command; a harness refuses one it does not know with the reason `invalid_args` |
| `skills` | list of strings | none | Skill directories for the agent; a harness that does not declare `loadsSkills` gets their names, descriptions and `SKILL.md` paths in the prompt (see [Skills](#skills)) |
| `wallTimeSecs` | number | the harness setting | The wall time the agent may run |
| `stallSecs` | number | the harness setting | How long it may go without a new output line |
| `resumeSession` | string | none | Continue an earlier session instead of starting one |

A harness takes a param from the step's `params` first and from the flow's own params (`ctx.params`) when the step has none, which is how `<harness>:prompt` flows work: `{ prompt, cwd, args? }` (`PromptFlowParams`).

The data every `agent` step records (`AgentResultData`): `exitCode`, `signal`, `sessionId`, `finalMessage`, `usage`, `log` (the path of the JSONL file; never the output), `durationMs`, `timings`, `stderr` (the last lines), and on `failed` `reason` and `message`. It also carries `context: { used, window? }` when the harness can tell: `used` is the last model call's input plus cache read and cache write, and `window` is the model's context window. A harness that cannot tell leaves it out; an unknown window is left out. A run that is not a finished reply need not carry it.

When a run compacted the harness session it also carries `compacted: true` and `compaction` (`AgentCompaction`): `reason` (`threshold` or `manual`), `before` and `after?` in tokens, and `flushed`, whether a silent memory turn ran first. A chat reads it to say so and to send its notes whole again.
`timings` holds three durations in milliseconds from the injected clock: `startToReadyMs` (the step's start to the worker's `session` line), `readyToFirstMs` (that line to the first text, thinking or tool line) and `totalMs` (the whole step). A duration whose line never came is `null`.

Every line of the step's log carries `receivedAt`, the epoch milliseconds when the host received it. Every harness writes one `session` line when its session is ready and the prompt is about to go to the model. Readers of older logs that have neither field still fold them.
`usage` has one shape for every harness (`Usage`): `harness`, `model`, `tokens` (`input`, `output`, `cacheread`, `cachewrite`), `costMicros` (`null` when unknown, `0` for a free run) and `costQuality` (`exact`, `estimated` or `incomplete` in `COST_QUALITIES`; `null` exactly when the cost is unknown). `validateUsage(value)` checks a value and names the first wrong field; `readUsage(data)` reads it back from a step's data, and still reads the old `usage` and `cost` fields of data written before the standard shape.

## The `<harness>:prompt` flow

Each harness ships one flow, `<harness>:prompt` (`claude:prompt`, ...): the `agent` step with `replay: "unsafe"` (a crash takes the `interrupted` edge, which ends `cancelled`), and, for `claude`, `codex` and `pi` (the ones that ask), a `person` wait whose choices are `allow_once` and `reject_once` with `allow_always` as a late choice, leading back to `agent`. A flow of your own follows the same shape: give the `agent` step a `waiting` edge to a `wait_person` step.

## Models and efforts

A harness plugin declares what a chat may pick:

| Field | Type | Meaning |
|---|---|---|
| `models` | `{ list, default, windows?, info? }` or a function of the settings | The models a chat may pick (an empty list: none can be chosen) and the one used when none is set. A function is called with the plugin's settings each time the list is read, so a harness can ask the agent itself. An entry of `list` is a model id, or a description with `id` and optional `name`, `provider`, `window` and `capabilities`; `info` carries the same descriptions by id. A bare id means the harness knows nothing more. `windows` maps a listed model to its context window in tokens when the harness knows it; a model with no entry has an unknown window |
| `efforts` | `{ list, default, flag? }` or a function of the settings | The same for effort, and the step argument that sets it (`--effort` when `flag` is absent). A function is called with the plugin's settings each time the list is read, so the default can follow a setting of its own. `pi` takes the default from operad's `thinkingLevel`, else pi's own `defaultThinkingLevel`, else pi's built-in level; `claude` takes it from its configured `effort` and declares no default when that is unset, because claude's built-in effort is not known without guessing |
| `capabilities` | `{ backgroundModel?, loadsSkills?, takesMessagesMidRun?, accessLevels? }` | What the agent does itself, and the model it prefers for background work. `backgroundModel` is a listed model id for work such as a bot's memory tidy; `claude` declares `haiku`, and the other harnesses leave it unset so a bot falls back to its own model. `loadsSkills: true` says it loads the skill directories the step gives, so the prompt needs no list of them; any other harness gets the list of [Skills](#skills). `takesMessagesMidRun: true` says it takes a message while its run is going, so a chat hands one to it through the inbox after the tool calls already running; any other harness gets no inbox and the message waits for the next run. `accessLevels` lists the chat access levels the agent carries; a chat at a level the agent does not list refuses the reply at its start instead of ignoring it |

Actions read them from `ctx.models[<plugin>]` and `ctx.efforts[<plugin>]`; `argsFor` uses them to build the [per-agent `if`/`then` choices](actions.md#per-agent-choices-with-if-and-then). A non-harness plugin that declares `models` is refused: `models: only a harness plugin declares models`.

A model's `capabilities` is a list of `vision` (accepts images), `reasoning`, `tools` and `web` (has its own web search). A harness declares only what it truly knows; a field or capability it cannot tell is absent, never guessed. `claude` declares anthropic models with vision, reasoning and tools; `pi` takes the provider, name, vision and reasoning from its registry; `codex` passes on what its app-server reports.

A chat reads `capabilities.takesMessagesMidRun` through `ctx.harnessCapabilities`; a step reads the inbox the chat passes in its params with `inboxOf(params)` from `@operad-io/harness-process`. The listener answers false when the run can no longer take a message, so the host does not count it as taken. `claude`, `pi` and `codex` declare it; `radian` does not.

A source reads `capabilities.backgroundModel` through `ctx.harnessCapabilities`, beside `ctx.harnesses`; a bot's memory tidy uses it when the bot sets no `backgroundModel` of its own. `claude` declares `haiku`; `pi`, `codex` and `radian` leave it unset.

A chat reads `capabilities.accessLevels` the same way. `claude` and `pi` list `plan`, `ask`, `edits` and `full`; `codex` and `radian` list none, so a chat at any level refuses the reply at its start with a message naming the level.

## Skills

A step may give skill directories in its `skills` param. A harness that declares `capabilities.loadsSkills: true` (`claude`, `pi`) loads them itself, and the prompt stays exactly what the step gives. For any other harness, `promptWithSkills(prompt, paths, capabilities)` of `@operad-io/harness-process` appends a short list: each skill's name, the description from its `SKILL.md` frontmatter and the path of that file, with one sentence to read the file before doing what it describes. It carries no skill body.

The list is capped: `MAX_PROMPT_SKILLS` skills and `MAX_PROMPT_DESCRIPTION_CHARS` characters of a description (then `...`), and it says how many skills the cap left out. A skill whose `SKILL.md` or name cannot be read is left out. A harness that declares `loadsSkills` gets its prompt unchanged.

These rules are for the list this param produces. A chat skill a person types as `/name rest` is different: a harness that does not declare `loadsSkills` gets that skill's body in the message, after a line naming the skill and before `rest`, while one that declares it gets `/name rest` unchanged (ADR 0028 D9).

## Pool workers

`pool/agent` is called from a flow with params:

| Param | Type | Meaning |
|---|---|---|
| `prefix` | string, non-empty | The pool's name; the own count of a worker is counted under it |
| `workers` | the worker definitions | At least one; see below |
| `fallbacks` | the worker definitions | Workers only a fallback may name |
| `worker` | string | Run this worker of `workers`, not the first with room. An unknown name ends `failed` with the reason `unknown_worker` |
| `holder` | string | Names who holds the place, for the waiting event |
| everything else | | Passed to the harness step (`prompt`, `cwd`, ...) |

A worker definition:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `use` | string | required | The harness step, `<plugin>/<step>` |
| `args` | list of strings | `[]` | Arguments for the harness step |
| `count` | integer | `1` | How many runs of this worker may go at once in one repository |
| `wallTimeSecs` | number | none | The wall time of one run; positive |
| `stallSecs` | number | none | The longest silence; positive |
| `fallback` | string | none | Another worker of the same set to run when this one's model fails |

Two counts decide whether a worker may start: its own `count` under the `prefix`, and the home-wide cap of its harness, `settings.harnesses` of the `pool` plugin (`{ "<harness plugin>": <count> }`, each an integer of at least `1`; a harness not listed has no limit; takes effect with the next `pool/agent` step that starts).
The step waits for the first worker with room, emits `pool.waiting` (`WAITING_EVENT`) when it has to wait and `pool.acquired` (`ACQUIRED_EVENT`) when it got a place after waiting, runs the harness step with `ctx.runStep`, and releases the places when the run ends.
A fallback is tried once, when the first worker's model is unavailable or at its usage limit, or the harness process could not start (`reason` `missing` or `spawn`); a session belongs to the worker asked for, so the fallback starts its own. A step that throws does not fall back: it fails as it would without one. The result's data adds `worker`, `harness` and, after a fallback, `fallbackFrom`.
`pool/agent` ends `done`, `failed`, `interrupted` or `waiting`, with a limit of eight hours (`timeoutSecs`). A `waiting` result from a harness is passed through with its question (`waitId`, `prompt`, `choices`, `resume`); the flow's wait carries it to a person, and the answer returns to the same worker with `resumeSession` and `askAnswer`.
The places are kept in a file under `<home>/pool`, because every step runs in a fresh worker thread that loads the plugin again; `PlaceBook` and `FilePlaces` are the two stores of places.

## Writing a harness

A new harness plugin:

1. `definePlugin` with `kind: "harness"`, one `agent` step that ends in end results, `resumable: true` when it takes `resumeSession` and `askAnswer`, `grants: false` when it cannot enforce one-time permissions, and `models` and `efforts` when the agent has a list.
2. Run the agent with the helpers of `@operad-io/harness-process` (a process group of its own, a wall time, a stall check, a JSONL log), never with your own `kill(-pgid)` or `fs.watch`: see [the rules](rules.md).
3. Report `reportWorkerStarted()` from [the platform module](platform.md#worker-reports) once the agent's program runs, so a pool's step can show it.
4. Write the agent's output to the step's log and put its path in the result's data.
5. Test it with a fake agent that prints fixed lines and the [testing helpers](testing.md).
