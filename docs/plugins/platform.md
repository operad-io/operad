---
description: The helpers of @operad-io/engine/platform: process groups, file locks, directory watches, sqlite open settings, step markers and worker reports.
---

# The platform module

`@operad-io/engine/platform` holds the pieces every plugin that touches processes, files or a database needs, written once. A plugin imports them from there and never writes its own:

```ts
import { runLine, withLockFile, watchDirectory, setBusyTimeout, enableWal } from "@operad-io/engine/platform";
```

A test fails when a source file outside `packages/engine/src/platform/` calls `linkSync(`, `process.kill(-` or `fs.watch(`, or imports `watch` from `node:fs`. See [the rules](rules.md#only-the-platform-module-touches-the-operating-system).
Nothing here runs in the kernel's own process.

## Process groups

A plugin that runs a command starts it in a process group of its own and stops only the group it started.
`runLine` is the whole thing for one shell line; the other helpers are what it is built from, exported for a plugin that streams a command's output its own way.

| Export | Type | What it does |
|---|---|---|
| `runLine(options)` | async function | Runs one shell line in a process group of its own and resolves with a `LineOutcome`. Cancelling (`signal`) or the timeout signals the group with SIGTERM and, after `KILL_GRACE_MS`, SIGKILL; the group is always stopped after the line exits too, so a child it forked cannot outlive it. A process that leaves the group on purpose cannot be signalled without risking an unrelated process, so the line stops reading its output instead (after `DRAIN_GRACE_MS`) |
| `killProcessGroup(pgid, signal)` | function | Sends a signal to a whole group: `true`, or `false` when it could not. This is the one place that calls `process.kill(-pgid, ...)` |
| `createGroupStop(options)` | function | The stop of one sentinel-led group: TERM, a wait, KILL, then repeated KILLs for a straggler. Returns `() => Promise<void>` |
| `ControlReader` | class | Reads the sentinel's control lines (`ready`, `end <status>`) in order from its stderr pipe |
| `exitFromStatus(status)` | function | `{ code, signal }` from the status a shell reports; above 128 it names the signal (130 reads as SIGINT even when the line exited 130 on purpose) |
| `endStatus(line)` | function | The exit status in a sentinel `end <status>` line, or `undefined` |
| `lastLines(text, count)` | function | The last `count` lines, with no trailing blank line |
| `systemClock` | `Clock` | The real `setTimeout`, `clearTimeout` and `sleep`; a test passes its own [fake clock](testing.md#fakeclock) |
| `KILL_GRACE_MS` | `500` | How long a group gets to end after SIGTERM before SIGKILL |
| `DRAIN_GRACE_MS` | `1000` | How long the pipes get to close after the group was stopped |
| `SWEEP_ATTEMPTS`, `SWEEP_PAUSE_MS` | `50`, `1` | How often the last SIGKILL is repeated for a straggler, and the pause between |

`runLine` options:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `line` | string | required | The shell line, run with `sh -c` |
| `cwd` | string | required | The working directory |
| `env` | record | `process.env` plus the step marker | Added to the environment |
| `timeoutMs` | number | none | The line is stopped when it runs this long |
| `signal` | `AbortSignal` | required | Aborting stops the group; a signal that is already aborted returns at once with `cancelled: true` |
| `logger` | `PluginLogger` | none | Output goes to this log as complete chunks, so a long command does not need its output in memory |
| `clock` | `Clock` | `systemClock` | Timers; a test injects its own |
| `sentinelScript`, `killGroup` | | | Test-only seams |

`LineOutcome` is `{ exitCode, signal, timedOut, cancelled, spawnError, log, tail }`: the exit code (or `null`), the signal name, whether the timeout or a cancel ended it, the error text when the shell could not start, the log's path, and the last lines of output (a bounded tail of 64 KiB).
The process the line starts leads its own group through a *sentinel*: it ignores SIGTERM, announces `ready` on a control pipe, runs the line in the same group, reports the line's status, and stays alive until the stop's last SIGKILL, so the group id cannot be reused by an unrelated group in between. It also watches the process that started it, and kills the whole group if that process is killed before it can stop it.

## What a step leaves behind

Every process a step starts through the platform carries an environment marker naming the run and the step. When the step ends the platform finds the live processes of the same user that still carry the marker and stops them (TERM, a bounded wait, KILL). The same sweep runs at `serve` start for markers of runs that are no longer active. A process that removes the variable from its own environment is not found.

| Export | What it does |
|---|---|
| `withStepMarker(marker, body)` | Runs `body` so every process started through the platform is marked. The registry does this around each step |
| `currentStepMarker()` | The marker of the step running now, or `undefined` |
| `markerEnv(marker?)` | The environment a process of the step gets: `OPERAD_RUN` and `OPERAD_RUN_HOME`; empty outside a step |
| `markerValue(marker)` | `<run id>:<step>` with spaces replaced by `_` |
| `homeToken(home)` | A short stable name for a home path (16 hex characters, never a space) |
| `MARKER_ENV`, `MARKER_HOME_ENV` | The names `OPERAD_RUN` and `OPERAD_RUN_HOME` |
| `trackRoot(pid)` | Tells the platform that the running step started a process of its own (the sentinel of a command or of a harness), so its descendants are followed |
| `enterStep(marker)` | Notes that a step began; the returned function notes that it ended and says whether it was the last with this marker. Two steps of one run and name at once share a marker, so only the last to end may sweep |
| `reapStep(marker, logger?, options?)` | Stops what a step left running and says so in the step's log |
| `reapMarked(options)` | The sweep behind the two: stops the marked processes `select` picks, up to `REAP_ROUNDS` times, and writes one line per process |
| `reapStale({ home, activeRunIds, log, ... })` | At `serve` start: stops the processes of this home whose run is not active, and says so once |
| `describeProcess(found)` | `pid: command` with the command cut to `COMMAND_WIDTH` characters |
| `StepTracker`, `pollTrackedSteps(table?)` | Follows the descendants of a running step (a poll every `TRACK_MS`, and on macOS a kqueue watch read every `WATCH_MS`); `pollTrackedSteps` looks at the table now, for a test that must not wait for a timer |
| `listMarkedProcesses`, `readProcessTable`, `parseEnvColumn(text)`, `parseStart(text)` | How the sweep reads the user's processes from `ps`; they work the same on macOS and Linux |
| `REAP_ROUNDS`, `TRACK_MS`, `WATCH_MS`, `COMMAND_WIDTH` | `3`, `200`, `2` and `120` |
| `machineLoad()` | `{ load1, cores }`: the one-minute load average (rounded to hundredths; `0` where the platform has none) and the core count, for a reader deciding whether a failure was load |

## Worker reports

A step that asked for a worker can learn about it while it runs.

| Export | What it does |
|---|---|
| `withWorkerReports({ placed?, started? }, body)` | Runs `body` so the pool and the harness below it report to these callbacks. Nothing is passed down through params, so a harness a flow names by data still reports |
| `reportWorkerPlaced(name)` | Said by the pool when it gave worker `name` a place |
| `reportWorkerStarted()` | Said by a harness once the program that does the work is running |

## File locks

Two kinds live here, and a plugin picks one instead of writing a third:

| Export | What it does | Use it for |
|---|---|---|
| `withFileLock(path, fn)` | Runs `fn` (synchronous) while holding an exclusive advisory `flock(2)` on `path`. The lock is on the open file, so the kernel releases it when the process dies, even with SIGKILL; the file may stay behind. Needs `flock`: `this needs flock(2), which is not available on <platform>` | A short critical section |
| `withLockFile(lockPath, work, options?)` | Holds a lock file made with link and rename and a nonce, whose record names the holder's pid, while `work` (sync or async) runs. Callers in two processes take turns, and callers in one process wait too. A lock whose holder died is taken over; takers go one at a time under a kernel `flock` on a guard file | A section that spans awaits and processes |
| `linkExclusive(source, target)` | Hard-links `source` to `target`; `false` when `target` exists. The link either creates `target` with the full content or fails, so a crash never leaves a half-written file | One-winner creation of a file |
| `LockTimeoutError` | Thrown by `withLockFile` when a live holder keeps the lock past the timeout: `<lockPath> is held by pid <n>` (or `unknown pid`); has `lockPath` and `holder` | |
| `LOCK_TIMEOUT_MS` | `10000`: how long a waiter accepts a live holder before it gives up | |
| `isAlive(pid)` | `true` while a process with the pid exists (`EPERM` means it exists) | |

`withLockFile` options: `clock` (`() => number`, default `Date.now`), `wait` (`(ms) => Promise<void>`, default a directory watch with a 200 ms fallback), `onLog` (default `console.error`) and `label` (names the lock in log lines, default `lock`). An unreadable lock record counts as dead once its modification time is 30 seconds old.
`lockTestHooks` holds the seams the lock's own tests use (a crash between the write and the link); a plugin never sets them.

## Directory watches

A store or log writes its files in one directory; watching the directory reports changes another process makes, which an in-process listener cannot see.
A watch is the fast path, not a promise: on macOS a write that lands in a sqlite `-wal` file may produce no directory event at all. Every owner pairs the watch with a check on a timer, and the timer comes from an injected clock so a test never waits for real time.

| Export | What it does |
|---|---|
| `watchDirectory(directory, onChange)` | Calls `onChange(filename \| null)` when anything in `directory` changes. Returns a stop function; a missing directory does nothing and still returns one |
| `waitForChange(directory, entry, ms)` | Resolves when `entry` (or an unnamed entry) changes in `directory`, or after `ms`, whichever is first. The directory is watched, not the file, because a rename replaces the file |
| `resolveSubscriptionWatch(options)` | The `{ pollMs, repeat, watch }` one subscription uses; `repeat` and `watch` can be replaced by a test |
| `followsChanges(options)` | `false` when `follow: false`, `readonly: true`, `readOnly: true` or `oneShot: true` is given (a command that answers once and exits has nothing to follow); otherwise `true` |
| `DEFAULT_POLL_MS` | `500`: how often an open subscription re-reads storage by default |
| `openWaitHandles`, `openWaitHandleCount()` | Test-only: the watches and timers `waitForChange` holds open; a suite asserts zero at the end, so a wait that forgets to close its handles fails |

## sqlite open settings

Two processes open the same SQLite file: a long-running runner and a command that reads or writes next to it. They must wait for each other instead of failing at once. Every SQLite database in the repository opens with these, in this order:

```ts
import { Database } from "bun:sqlite";
import { enableWal, setBusyTimeout, writeImmediate } from "@operad-io/engine/platform";

const db = new Database(file);
setBusyTimeout(db);
enableWal(db);
writeImmediate(db, () => db.query("INSERT INTO t VALUES (1)").run());
```

| Export | What it does |
|---|---|
| `BUSY_TIMEOUT_MS` | `5000`: how long a writer waits for another writer before `SQLITE_BUSY` |
| `setBusyTimeout(database)` | Installs the busy handler (`PRAGMA busy_timeout`) so ordinary lock acquisition waits |
| `enableWal(database, onBusy?)` | Switches the store to WAL, which lets a reader keep a snapshot while another process appends. Two processes opening a fresh store race for the lock the switch takes: the loser waits for the winner through an immediate transaction and then sees WAL. `onBusy` is told each time the switch met `SQLITE_BUSY`. A database that cannot be WAL (an in-memory one) is an error: `the database could not switch to WAL (journal mode stays <mode>)` |
| `isBusy(error)` | `true` for an `SQLITE_BUSY` error |
| `writeImmediate(database, work)` | Runs `work` in an immediate transaction and waits for other writers as long as they make progress. The busy handler gives up after `BUSY_TIMEOUT_MS`, but a writer that commits again the moment it releases can keep another connection waiting longer on a slow disk with nothing stuck; so `SQLITE_BUSY` is final only when no other connection committed while this one waited |

Do not open a SQLite file with any other settings, and do not sleep and retry: the busy handler is the wait.
