# operad agent instructions

operad is an open orchestration layer for coding agents. It is a Bun + TypeScript
workspace:

| Package | What it is |
|---|---|
| `packages/engine` (`@operad-io/engine`) | the graph engine: event-sourced, resumable runs of a graph whose structure is data and whose node logic is TypeScript |
| `packages/cli` (`@operad-io/cli`) | the `operad` command |

The direction, the decisions in force and the open questions are in
`docs/backlog/operad.md`; each part has its own item (`operad-engine.md`,
`operad-plugins.md`, `operad-harness.md`, `operad-channels.md`,
`operad-contract.md`, `operad-presentation.md`, `operad-conversation.md`,
`operad-sandbox.md`, `operad-assistant.md`). Read the items that touch what you change before you
change it, and do not contradict a decided point. A change that needs a decided
point reversed changes that item first, in its own docs-only commit.

## The kernel stays small

`docs/backlog/operad.md` decisions 12 to 15 set the boundary. The kernel has the
fact log (behind a storage backend interface), flow execution, four basic steps
(call a plugin step, wait for a person, wait for a time or condition, end),
plugin loading, and three views. Everything else is a plugin: running commands,
scheduling, git, workers, review, merging. Do not add a feature to the kernel
that a plugin could provide.

## User vocabulary

A user of the kernel sees three words: **flow**, **pending** (things waiting for
a person, each with the actions its plugin defines) and **history** (what each
step did and why). Every other user-visible word belongs to a plugin (the `dev`
plugin's plan, task, brief, rework, confirm, merge, reject, cancel, auto). Internal
names (graph, node, fact, effect, decide, evolve, runner, backend) never appear in
command names, command output, errors meant for users, or user docs. A new
user-visible word needs the owner's approval: say so in the final answer instead
of adding it.

## Rules

- Configuration files are JSON, each with a JSON Schema in the package that reads it. Flows and plugins are TypeScript; nothing else is.

- Runtime is Bun. Run TypeScript directly; there is no build step. Use `bun:test`
  for tests and `bun:sqlite` rather than an npm SQLite package.
- Add a runtime dependency only when a task says so. The engine has none.
- Strict TypeScript (`tsconfig.base.json`). No `any`, no `@ts-ignore`, no
  non-null `!` to silence the checker.
- Every behaviour has a test. A test that needs time uses an injected clock; a
  test that needs a crash kills a real child process. No sleeps to wait for
  something: wait for the event.
- Repository text (code, comments, commit messages, docs outside
  `docs/backlog/`) is English.
- A child process gets at most three stdio entries and no code reads `stdio[3]` or higher: Bun closes an extra pipe twice and kills the process when SQLite owns the number (bf3a73e). Send extra output to a file. A test enforces it.
- Never write under `.git`.
- Plugins use `@operad-io/engine/platform` for processes, locks and watching (process groups, file locks, directory watches, sqlite open settings); a test fails when a source file outside it calls `linkSync(`, `process.kill(-` or `fs.watch(`.

## Mutation records

A mutation check breaks the new code once by hand, runs the tests, names the test
that fails, and restores the code. Record each in `MUTATIONS.md` at the root. A
row's id is the arc task id followed by `-M` and a number starting at 1 for each
task: `TK0001-M1`.

## Verify

Run this before you say a change is done. It must pass.

```sh
bash scripts/verify.sh
```

It runs `bun install --frozen-lockfile`, `bunx tsc -b` and `bun test`.
