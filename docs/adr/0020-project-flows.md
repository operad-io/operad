# ADR 0020: Project Flows in the `dev` Plugin

Status: accepted

## Background

The `dev` plugin supplies the skeleton of a development flow and its steps: a worktree, work, checks, review, a person's decision, and integrate. The concrete flow is the project's to choose, because projects differ in what they check, who reviews and whether a person decides. A flow written as a fixed state machine inside the plugin would force every project into one shape.

## Decisions

### D1: A flow is written in the project's `dev.json`

The project's `.operad/dev.json` is JSON with a JSON Schema. `flows.<name>` is one flow; `default` is the one used when none is named. `dev` compiles it into the engine's flow value; the user writes no graph and no edges.

### D2: A flow is an ordered list of stages

`work` is a stage too. There are four kinds:

- `work`: a worker changes the code. Parameters: `use`, `args`, `brief` (an extra paragraph added to the worker's prompt), `beforeAttempt` (for example `merge-main`), `pool`, `workerBrief`, `commit`.
- `check`: runs commands. Parameters: `commands`, `rerun`.
- `review`: a model reviews. Parameters: `use`, `args`, `later` (the arguments of the reviews after the first), and a grading name (the flow's entry in `.operad/review.json`).
- `human`: waits for a person to decide.

### D3: `dev` completes the route

When a stage fails, the run returns to the nearest `work` stage before it and redoes it; with no `work` stage before it, the run waits for a person. Retries, timeouts, cancellation and the wait for an unavailable model behave as they do for the built-in flow. `dev` adds the worktree preparation at the start and integrate at the end. The plan's `auto` setting decides whether a `human` stage ends in waiting for a person or in an automatic merge.

### D4: Two hard rules

`dev` checks them when it loads a flow and refuses a flow that breaks one, saying why:

- The last step is integrate; a change reaches main only through it.
- A flow has at least one `check`, `review` or `human` stage.

Everything else is the project's decision. A flow that wants no model review has no `review` stage.

### D5: A plan or task chooses its flow with `--flow <name>`

Without it, `default` is used. A task does not change its flow after its first attempt starts. A `--flow` naming no flow stops the task from starting and says why.

### D6: Complex flows are TypeScript

A project may write `.operad/flows/<name>.flow.ts` with `defineFlow` and build any graph from `dev`'s documented steps, each of which states its result and parameters. `dev` applies the same hard rules (D4) to such a file, and refuses one whose name `dev.json` also defines.

### D7: The built-in flow is the default configuration

A repository that writes no `flows` runs the built-in flow. The existing `worker`, `reviewer` and `gate` settings of `dev.json` stay valid as the parameters of the `default` flow.

### D8: Grading is per flow

The grading entries in `.operad/review.json` correspond one to one to flow names.

### D9: `pool`, `workerBrief` and `commit` of a `work` stage

These serve flows whose work differs from writing code, such as producing images with rules opposite to those for code.

- `pool`: the pool of the repository's `dev.json` the stage takes its worker from; unset is `default` (ADR 0021). A task's `--flow` therefore chooses its pool; `task add` accepts it and it can change until the first attempt starts (D5). The stage takes a place in that pool.
- `workerBrief`: a file path whose text replaces the repository's `workerBrief` for this stage; it does not add to it. `brief` stays an additional paragraph.
- `commit`: when true, `dev` commits the uncommitted changes in the worktree after the worker ends, with a message carrying the task id. It serves workers whose sandbox cannot write `.git`. Unset is false: the worker commits itself.

### D10: A client may change `dev.json` flows through settings; `dev` checks them on save

`flows` of `dev.json` is a per-repository setting a client may change, whole or one flow by name (`dev.flows.<name>`), through the settings interface of ADR 0017. Before the file is written `dev` checks the whole file as it would be: the schema, the hard rules of D4 and the name clash of D6 with a TypeScript flow. A change `dev` refuses is refused with `dev`'s own reason, word for word, and nothing is written; a client never repeats the rules. The flows of a repository, TypeScript ones included, are listed by the read-only setting `dev.flowList`: each flow's name, its source (`dev.json`, a TypeScript file or the built-in default), its stages for a `dev.json` flow, and for a TypeScript flow the steps `dev` reads when it loads the file, or `dev`'s reason for refusing the file. A TypeScript flow is still written as a file, not through settings.
