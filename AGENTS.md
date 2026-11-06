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
`operad-assistant.md`). Read the items that touch what you change before you
change it, and do not contradict a decided point. A change that needs a decided
point reversed changes that item first, in its own docs-only commit.

## Rules

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
- Never write under `.git`.

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
