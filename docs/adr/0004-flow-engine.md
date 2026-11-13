# ADR 0004: The Flow Engine

Status: accepted

## Background

A task lifecycle that is one fixed pipeline lets configuration change only parameters. What is wanted is a graph that can be configured: a node is a step, an edge is an outcome, and any node can point to a local TS file for customisation. Nodes span days (waiting for a person, for CI, for a timed re-check), so the engine must be event-sourced, resumable and idempotent. The kernel of agent-autoloop (a pure `decide`, a single-writer `evolve`, an append-only log, `why` for one round) and the checkpoints of pi durable (a recoverable state machine per step, and only `replay: safe` steps re-run) are two precedents that can be compared.

## Decisions

### D1: A flow is a TS module

A flow is a TS module whose default export is the value of `defineFlow(...)`: steps, edges, and the kind and parameters of each step (data). The custom logic of a step is a TS file. The engine internally calls this structure a graph.

### D2: The engine is event-sourced

Every accepted input produces a batch of facts, and the state is computed from the log (internally the pure functions decide and evolve, not exposed to users). A user sees every step and its reason in "history". The log never stores a secret.

### D3: A node declares whether it can be replayed

After a crash, a node that can be replayed runs again; one that cannot gives its downstream an "interrupted" outcome. Consecutive crashes up to a limit stop the run and wait for a person.

### D4: Four basic steps

The kernel has four basic steps:

- call one step of a plugin;
- wait for a person (the turn ends, the answer is an event, and the wait appears in pending);
- wait (for a time, or for the condition a plugin check reports);
- end.

Running commands, running checks, running a harness, sending to a channel and landing a change are all steps that plugins provide. Parallelism and joining are added later.

### D5: A flow can be generated from a project's JSON configuration

A plugin may generate a flow from a project's JSON configuration (`dev` compiles the stage list of `.operad/dev.json` into a `defineFlow` value). A generated flow and a flow written in TS are not different to the engine.

### D6: Idempotence and circuit breaking are in the core

- An event with the same source and the same number is recorded once.
- An event raised by an event carries a hop count; past the limit it is recorded and not dispatched.
- A run of one flow that fails consecutively up to the limit is not retried.

### D7: One run per flow per object

For the same flow and the same object there is only one run at a time.

### D8: Tests

The engine's tests include a fixed-seed simulation, bounded exhaustive exploration, and a resume after a really killed process.
