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
`operad-sandbox.md`, `operad-assistant.md`, `operad-worker-pool.md`, `operad-dev-flows.md`,
`operad-open-framework.md`, `operad-slimming.md`, `operad-test-slimming.md`). Read the items that touch what you change before you
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
that fails, and restores the code. One check per new or changed behaviour is
enough: break that behaviour once and name the test that catches it. A bug fix
needs one, showing the new test fails on the old code. A refactor or a move that
changes no behaviour needs none; the existing tests passing is its check.
Record each in the `MUTATIONS.md` of the package whose code the mutation broke
(`packages/<name>/MUTATIONS.md`); the root `MUTATIONS.md` indexes the package
files. A row's id is the arc task id followed by `-M` and a number starting at 1
for each task: `TK0001-M1`. Rows are only appended, and `.gitattributes`
merges every `MUTATIONS.md` as a union, so both sides' rows are kept on a merge.

## Flaky tests

A test that failed and then passed on rerun is a bug until shown otherwise.
Never raise a timeout or add a retry inside a test to make it pass.

Only a task that fixes a flaky test runs `scripts/stress.sh`, and it runs it
twice: once to reproduce before the fix and once to confirm after it. Every
other task's check is `bash scripts/check-changed.sh`: the packages the change
touches and the packages that load them. The full `bash scripts/verify.sh` runs
once more at integration, before merge.

Size a stress run by time, not by a fixed count: time one run of the file
alone, then choose `--runs` so the stress run takes about ten minutes, at least
20 runs and at most 200, with `--load 2`. The task is done when that run
passes; its final answer states the command, the number of runs and the result
before and after the fix.

A stress run takes a lock shared by every stress run on the machine (all
worktrees), so it may wait for another run to end; it prints which run holds
the lock while it waits. The wait is not part of its result: size and judge the
run by its own time and counts. `--no-lock` skips the lock only for a run that
knows it is alone.

Run one stress run at a time, in the foreground: never two at once, never in
the background, never left running when the task ends.

A failure seen only while the machine was overloaded (load average far above
the number of cores) is not yet a flaky test. Note the load, and reproduce it
with a stress run before you change anything.

## Verify

Run this before you say a change is done. It must pass. A task worker runs
`bunx tsc -b` and the test files it added or changed instead; the task's check
runs `bash scripts/check-changed.sh` after it, and the full suite runs before
merge.

```sh
bash scripts/verify.sh
```

It runs `bun install --frozen-lockfile`, `bunx tsc -b` and `bun test`.

A task that changes how checks run (the gate, integration or rerun commands in
`.operad/dev.json`, `scripts/remote-check.sh`, `scripts/run-tests.sh`,
`scripts/check-changed.sh`, `scripts/verify.sh`) runs each changed command once
through `scripts/remote-check.sh` on the check host before it is done, including
the rerun of one failing test, and its final answer gives the command and the
result. dev reads these commands from main, so a task's own check runs the old
ones and cannot show the new ones work (T-0234's rerun broke every check after
it merged, 2026-11-11).
