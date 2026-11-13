# ADR 0001: The Direction of operad

Status: accepted

## Background

Before operad, task orchestration lived inside the radian binary: the worker was only `radian acp`, the hub routed sessions only for radian's journal and control port, and the task lifecycle (worker, the gate stages, a person, merge) was one fixed pipeline. Real use is already several agents: Claude Code, pi and radian each have sessions, while the orchestration manages tasks, and a phone needs two apps. The orchestration experience on iOS is good; what is missing is that it sees only radian and has only one flow.

Three peer projects (agent-autoloop, noop, bb) show that "orchestrate any command-line agent" can be a small layer. They also share two gaps: no verification gate and no sandbox of their own. noop and DeepSeek Super-agent orchestrate personas (lead, dispatcher, Router); operad orchestrates flows, and a role is only a parameter of a step.

## Decisions

### D1: operad is an open orchestration layer

operad is the next generation of the orchestration, an open layer with six requirements:

- more harnesses;
- more channels;
- a workflow is an easily configured graph;
- it orchestrates flows, not roles;
- it can serve the personal-assistant scenario;
- a user describes a need, and an agent writes a local plugin or a custom step right away, usable at once.

### D2: radian is a pure agent

radian keeps sessions, journal, TUI, `radian exec`, `radian acp`, permissions and sandbox, providers, memory and skills. The orchestration subcommand, its TUI panel and the hub's task routing belong to operad, not radian.

### D3: The product is operad: a new repository, TypeScript, Bun

The name comes from the operad in mathematics: an operation with n inputs and one output, and the algebra of how such operations nest and compose, which is what the graph engine does. The word contains "rad", the same family as radian.

- The CLI command is `operad`. The npm package `@operad-io/cli` installs the command `operad`; the other packages are `@operad-io/*`. The npm org is `operad-io`. (Unscoped `operad` is rejected by npm as too similar to `openai`, and `@operad` is taken by operadhq.) Package names such as `@operad-io/harness-claude` keep this form.
- The domain is `operad.io`. The GitHub org is `operad-io` and the repository is `operad-io/operad`, public, licensed MIT.
- The runtime is Bun.
- There is one reason for TypeScript: the extension surface must be text that hot-loads without a build, that an agent can write in seconds, in the same language as the kernel, so that `operad plugin check` can type-check it.
- A trusted plugin loads in process; this is the fast path. An untrusted or generated step runs across a process boundary and inside a sandbox, with the same contract. No runtime gives a real isolation boundary in process, so "the same process" is not a reason for the language.
- A second plugin language is added later through a cross-process plugin host, with the contract unchanged.
- A Rust kernel with a TS runtime would work but contradicts the one reason above.

### D4: The flow engine is the core

The flow engine is the new core, and the previous fixed pipeline is expressed by the `dev` plugin as the first flow. The engine calls the structure of a flow a graph internally; a user sees only "flow".

### D5: A flow's structure is data; custom logic in a step is a TS file

The structure of a flow is data, and the custom logic inside a step is a TS file. Plugins provide steps; the rest is written in TS. A phone shows flows and run state and does not edit them.

### D6: The first vertical scenario is the coding flow

The verification gate and the forge are proven in the coding flow. The personal assistant is the second scenario grown from the same engine.

### D7: What operad does not take from peers

- A model deciding in place of the owner (a shadow judge only measures accuracy).
- An agent directly changing its own prompts and policies.
- A cloud rendezvous point that is required.
- "Trust the self-report plus CI" without a gate.
