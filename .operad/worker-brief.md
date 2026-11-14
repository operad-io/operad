# Working on operad

Read `AGENTS.md` before you change anything. It names the decisions to read and
the boundary the kernel keeps.

- Do not contradict a decided point in `docs/adr/`. A change that needs one
  reversed changes that ADR first, in its own docs-only commit merged with the
  code. An ADR is a snapshot; intended work lives in `docs/backlog/`, one file
  per item, and references the ADRs it touches. A backlog file is deleted when
  its item lands and its decisions are written into ADRs.
- The kernel stays small. A feature a plugin could provide belongs in a plugin.
  A user of the kernel sees three words: flow, pending, history. Every other
  user-visible word belongs to a plugin.
- Use Bun and TypeScript directly; there is no build step. Use `bun:test`, and
  add a runtime dependency only when a task says so. The engine has none.
- Configuration files are JSON, each with a JSON Schema in the package that
  reads it. Flows and plugins are TypeScript.
- Strict TypeScript: no `any`, no `@ts-ignore`, no non-null `!` to silence the
  checker.
- Every behaviour has a test. A test that needs time uses an injected clock; a
  test that needs a crash kills a real child process. Wait for the event, do not
  sleep for it.
- Record each mutation check in the `MUTATIONS.md` of the package whose code it
  broke (`packages/<name>/MUTATIONS.md`), with an id of `<task id>-M<n>`. The
  root `MUTATIONS.md` indexes the package files.
- Repository text is English.

Before you finish, run `bunx tsc -b` and the test files you added or changed
(`bun test --timeout 30000 <files>`), and make them pass. Do not run
`bash scripts/check-changed.sh` or `bash scripts/verify.sh`, and do not wait
for other checks to end: the task's check runs `check-changed.sh` after you
finish, with a limit on how many checks run on this machine at once, and the
full suite runs before merge. A task whose brief names another check runs
that one too.

Commit each whole piece of work as you finish it and leave the worktree clean.
Never write under `.git`. Never kill, signal or stop a process you did not start.

End your final answer with `New words: none` or `New words: <word>, <word>`,
naming the user-visible words the change adds (command or action names, setting
keys, labels; not whole sentences), so the lead can tell the owner.
