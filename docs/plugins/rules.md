---
description: The rules every plugin must follow: no output at load, stdio entries, platform helpers, facts, tests and vocabulary.
---

# The rules plugins follow

Each rule has a reason and, where a test enforces it, the test.

## Print nothing when the module loads

A process that loads plugins must write nothing to standard output while it does. `serve` keeps itself on the code that is on disk: when a file changes it starts a fresh process, `operad check-load`, which loads every enabled plugin and prints one line to standard output for each problem it found.
The parent reads that standard output as the list of problems, so **a line your module prints while it loads is read as a load problem**, and `serve` refuses the new code: `code changed (<files>) but does not load; the old code keeps running: <your line>`. The same holds for a command that prints before it has anything to say.

- No `console.log`, no `process.stdout.write`, no banner, no debug line, at the top level of the module or in `definePlugin`'s argument.
- A plugin that has something to report records it with `ctx.logger` or a fact when it runs, never at load.
- A line to the error stream is not read as a problem unless the process exits non-zero, but the engine's own load logs go to the error stream, and a plugin adds none.
- This is why a command name that two plugins share, or that a kernel verb owns, gets no short form *and no log line*: a line printed there would refuse the new code. `<plugin> <command>` always works.

## At most three stdio entries

A child process gets at most three stdio entries (`stdin`, `stdout`, `stderr`), and no code reads `stdio[3]` or higher. Bun closes an extra pipe twice: once when the stream ends and once when the child object is collected. In between, a SQLite database can take the descriptor number, and macOS kills the process with `EXC_GUARD` (exit 137). Send extra output to a file. A test, `packages/harness/process/test/stdio-guard.test.ts`, fails on a spawn with more entries or a read of a higher one (commit `bf3a73e`).

## Only the platform module touches the operating system

Plugins use `@operad-io/engine/platform` for processes, locks and watching. A test (`packages/engine/test/platform/no-copies.test.ts`) fails when a source file outside `packages/engine/src/platform/` contains:

| Forbidden | Use instead |
|---|---|
| `linkSync(` | `linkExclusive` or `withLockFile` |
| `process.kill(-` (a signal to a process group) | `killProcessGroup` or `runLine` |
| `fs.watch(`, or `import { watch } from "node:fs"` | `watchDirectory` or `waitForChange` |

Open every SQLite database with `setBusyTimeout`, `enableWal` and `writeImmediate`; do not sleep and retry. See [the platform module](platform.md).

## Never signal a process you did not start

Stop only the group you started (`runLine` does). Do not call `kill` on a pid you did not create, and do not sweep by name.

## Facts hold data and paths, never output

Write what a command printed to `ctx.logger` and keep the path in the fact. Never put a secret in a fact or in an object's data; a `Secret` throws when serialised so a mistake fails at once.

## The kernel stays small

A feature a plugin could provide belongs in a plugin. A user of the kernel sees three words: **flow**, **pending**, **history**. Every other user-visible word belongs to a plugin. The internal names (graph, node, fact, effect, decide, evolve, runner, backend) never appear in command names, command output, errors meant for users or user docs; a plugin author's page like this one may use the API's type names.

## Configuration is JSON with a schema

A configuration file is JSON and has a JSON Schema in the package that reads it; flows and plugins are TypeScript. Settings a plugin reads go in its `settings` schema ([Settings](settings.md)).

## Code

- Bun and TypeScript run directly; there is no build step. Tests use `bun:test`; SQLite is `bun:sqlite`.
- Strict TypeScript: no `any`, no `@ts-ignore`, no non-null `!` to silence the checker.
- A runtime dependency is added only when a task says so; the engine has none.
- A plugin must not do work in the module scope that depends on the environment (a path, a network call): the module is imported by every command, by the reload probe and by each step's worker.

## Declarations

- A step's `results` and every flow's edges agree (see [Flows](flows.md)); a step that calls others lists them in `calls`.
- An event a step sends begins with the plugin's name and a dot.
- A `row` is synchronous and fast (50 ms); a `load` finishes within ten seconds.
- A step that can run again after a crash is `replay: "safe"`; one that cannot is `"unsafe"` and its flow has an `interrupted` edge.

## Tests

- Every behaviour has a test. A test that needs time uses an injected clock ([`fakeClock`](testing.md#fakeclock)); a test that needs a crash kills a real child process.
- Wait for the event; do not sleep for it. A test that failed and then passed on rerun is a bug until shown otherwise; never raise a timeout or add a retry inside a test.
- Run a test file with `bun test --timeout 30000 <file>` and the type check with `bunx tsc -b`.
