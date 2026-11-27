---
description: The helpers of @operad-io/engine/platform: process groups, file locks, pseudo terminals, folder holds, directory watches, atomic writes, sqlite open settings, step markers and worker reports.
---

# The platform module

`@operad-io/engine/platform` holds the pieces every plugin that touches processes, files or a database needs, written once. A plugin imports them from there and never writes its own:

```ts
import { runLine, withLockFile, watchDirectory, setBusyTimeout, enableWal } from "@operad-io/engine/platform";
```

A test fails when a source file outside `packages/engine/src/platform/` calls `linkSync(`, `process.kill(-` or `fs.watch(`, imports `watch` from `node:fs`, or names a temporary file with a template literal ending in `.tmp`. See [the rules](rules.md#only-the-platform-module-touches-the-operating-system).
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
The process the line starts leads its own group through a *sentinel*: it ignores SIGTERM, announces `ready` on a control pipe, runs the line in the same group, reports the line's status, and stays alive until the stop's last SIGKILL, so the group id cannot be reused by an unrelated group in between. It also watches the process that started it, and kills the whole group if that process is killed before it can stop it. A line that reported its own status is stopped with SIGKILL at once, and the stop looks again for a child forked as the signal went out, so neither the line's own work nor the sentinel's `sleep` outlives it.

## Pseudo terminals

A program that needs a terminal runs on one from Bun, with no native module. POSIX only. The child leads a process group of its own and has three stdio entries, all on the terminal.

| Export | Type | What it does |
|---|---|---|
| `spawnPty(options)` | function | Starts `argv` on a new pseudo terminal and returns a `Pty`. It throws when the program or the directory does not exist, or when this Bun has no pseudo terminal. The group is stopped on `kill` and when the child exits (SIGTERM, then SIGKILL after `KILL_GRACE_MS`). A process that moved to another group, such as a job of an interactive shell, is not part of that stop; `hangUp` stops those too, also after the child exited |

`spawnPty` options:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `argv` | non-empty array of strings | required | The program and its arguments; no shell reads them |
| `cwd` | string | required | The working directory |
| `env` | record | `process.env` plus the step marker | Added to the environment; `TERM` is not set for the caller |
| `cols`, `rows` | number | required | The size of the terminal |
| `onData` | function | required | Receives the output bytes as they come |
| `clock` | `Clock` | `systemClock` | Timers; a test injects its own |
| `table` | `ProcessTable` | `readProcessTable` | How the processes are listed; a test replaces it |

A `Pty` has `pid` (also the group id), `marker`, `write(data)`, `resize(cols, rows)`, `kill()`, `hangUp()`, `alive()` and `exited`. Every process of a terminal inherits `marker` as `OPERAD_PTY`. `hangUp` closes the terminal on everything the child started, whatever group it moved to: SIGHUP to each, the group stop of `kill`, and after one more grace SIGKILL to what is left. It works after the child exited, finding what is left by the marker; a process that leads a session of its own is a daemon and is left alone, and on macOS a process of Apple's own binaries shows no marker. When the processes cannot be listed it still stops the group, rejects, and the next call tries again. `alive` resolves `true` while a process it would stop runs. `write` and `resize` do nothing once the terminal is closed. `exited` resolves with `{ code, signal }` after the child exited, its group was stopped and the output was delivered (waiting at most `DRAIN_GRACE_MS` for the end of the output); a child that a signal ended has the code 128 plus the signal number.

## Folder holds

A plugin that keeps a process working in a folder says so in the home, and whatever is about to remove a folder stops those processes first. Neither side knows the other.

| Export | What it does |
|---|---|
| `holdFolder({ home, folder, pid, marker? })` | Records that the process tree under `pid`, a child of this process, works in `folder`; `marker` is a `Pty`'s, so a release also finds what is left after `pid` ended. Returns a `FolderHold`: `released()` says whether a release stopped the tree, and `drop()` takes the hold off the list once the tree ended |
| `releaseFolder(home, folder, options?)` | Stops with SIGKILL, without waiting, every held tree in `folder` or below it, and returns how many holds it stopped. It never throws. A process that is no longer its holder's child is not signaled; a hold that names nothing left to stop is dropped. `options.table` replaces the process table in a test |
| `FOLDER_HOLDS_DIRECTORY` | `folder-holds`, the directory in the home |
| `processTree(rows, pid)` | The rows of `pid`, of everything below it, and of every member of a group one of those leads |
| `signalRows(rows, signal)` | Sends one signal to each process of the rows; one that ended is passed over |
| `markedRows(rows, marker)` | The rows of what a pseudo terminal with that marker started: its carriers, what is below them and their groups, without daemons |
| `mergeRows(...lists)` | One row for each process of several lists |
| `PTY_MARKER_ENV` | The name `OPERAD_PTY` |

## What a step leaves behind

Every process a step starts through the platform carries an environment marker naming the run and the step. When the step ends the platform finds the live processes of the same user that still carry the marker and stops them (TERM, a bounded wait, KILL). A step that started no marked process has nothing to find and reads no process table. The same sweep runs at `serve` start for markers of runs that are no longer active. A process that removes the variable from its own environment is not found. A process that has ended and waits for its parent to reap it (a zombie) runs nothing and cannot be stopped, so the process table leaves it out: no sweep waits its grace out or reports it as left running.

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
| `StepTracker` | Follows the descendants of a running step (a poll every `TRACK_MS`, and on macOS a kqueue watch read every `WATCH_MS`) |
| `listEnvCarriers(name, value)` | The pids of the user's processes whose environment holds `name=value` |
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

## Kept workers

A harness may keep its child after a reply, so the next reply does not start it again. A kept worker has no run marker: it belongs to the home, not to the run that started it, and a record under the home is how another process finds and ends it. Only the owner can read the directory or open the socket; both are created with owner-only permissions.

| Export | What it does |
|---|---|
| `KEPT_WORKER_MS` | `600000`: how long a kept worker stays after its reply when no other reply arrives |
| `MAX_KEPT_WORKERS` | `3`: how many workers one home keeps; a fourth ends the one idle longest |
| `KEPT_FIRST_LINE_MS` | `5000`: how long a kept worker may take to answer the first line of a new reply before it is given up |
| `KEPT_STOP_GRACE_MS` | `500`: how long a worker gets to end after the stop request, before SIGKILL |
| `KEPT_WORKER_FLAG` | `--operad-kept`: the command-line flag whose value is a worker's token, so a record's pid can be checked before it is signalled |
| `keptWorkerDirectory(home, name)` | The directory one harness keeps its workers in: `<home>/harness/<name>/kept` |
| `newKeptWorkerSlot(home, name)` | A new `{ dir, token, socket, meta }`; the directory is made with mode `0700` |
| `keptWorkerArgument(token)` | The command-line argument a kept worker carries: `--operad-kept=<token>` |
| `writeKeptWorker(record)` | Writes one record whole, with mode `0600`, so a reader sees the old record or the new one |
| `removeKeptWorker(record)` | Removes a record and its socket; safe when they are already gone |
| `readKeptWorker(meta)` | That one record, or `undefined` when the file is missing, still empty or otherwise not a record |
| `readKeptWorkers(home, name)` | Every valid record of one harness in a home; a record that cannot be read is skipped |
| `readKeptWorkersInHome(home)` | Every valid record of every harness in one home, which the shared limit of three counts |
| `stopKeptWorker(record, options?)` | Asks a worker to stop over its socket, then signals only the process whose command line carries its token; removes the record |
| `stopKeptWorkers({ home, name, filter?, clock? })` | Ends the workers of one harness that match `filter` (`scope`, `key`, `except`), oldest first |
| `stopAllKeptWorkers({ home, clock? })` | Ends every kept worker of every harness in one home; `serve` start and stop use it so none runs older code |

A record names the worker's `pid`, `token`, `scope` (the chat or other owner), `key` (what the worker was started with), `socket`, `meta`, `session`, `startedAt`, `lastUsedAt` and `busy`. A filter matches those fields.

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
| `followsChanges(options)` | `false` when `follow: false` is given (a command that answers once and exits has nothing to follow); otherwise `true` |
| `DEFAULT_POLL_MS` | `500`: how often an open subscription re-reads storage by default |
| `openWaitHandles`, `openWaitHandleCount()` | Test-only: the watches and timers `waitForChange` holds open; a suite asserts zero at the end, so a wait that forgets to close its handles fails |

## Atomic writes

A file another process may read while it is being replaced is written through a temporary file in the same directory, flushed, then renamed over the target. A crash leaves the old file or the new one, never half of either, and the temporary name carries the pid and a random value so two writers never share it. The target's mode is kept; a caller that names a mode gets it exactly.

| Export | What it does |
|---|---|
| `writeFileAtomic(path, text, options?)` | Writes `text` through a temporary file and a rename. `options.mode` sets the mode (default: keep an existing file's); `options.beforeRename(temporary, file)` runs once the temporary file is complete, and a test uses it to stop the write before the rename |
| `writeFileAtomicSync(path, text, options?)` | The synchronous form; `beforeRename` runs synchronously |
| `writeJsonAtomic(path, value, options?)` | The same for a JSON value. `options.space` indents it (`2` for a readable file) and `options.newline` adds a trailing newline (default `true`) |
| `writeJsonAtomicSync(path, value, options?)` | The synchronous form |
| `AtomicWriteOptions`, `AsyncAtomicWriteOptions` | The options of the two file writers: `mode` and the synchronous or asynchronous `beforeRename` |
| `JsonWriteOptions`, `AsyncJsonWriteOptions` | Those options plus `space` and `newline` for the JSON writers |

The parent directory is created when it is missing. Do not write a temporary file and rename it by hand; the platform helper is the only copy.

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

## The git program

A plugin that runs git asks the platform for the program and spawns the path it returns, never the word `git`. A PATH that changed after the process started (a new install) is not seen by a spawn of the bare name, and on macOS `/usr/bin/git` is a stub that opens Apple's install dialog when the command line tools are missing.

| Export | Type | What it does |
|---|---|---|
| `findGit(host?)` | function | The absolute path of a git that can be run, or `undefined`. It never runs git and never opens an installer. On macOS `/usr/bin/git` counts only when `/usr/bin/xcode-select -p` names a directory holding `usr/bin/git`. On Windows it also looks in the usual `Git\cmd` places. Nothing is cached, so a git installed later is found on the next call |
| `GIT_NOT_INSTALLED` | `"git is not installed"` | The error text a caller returns when `findGit` finds nothing |
| `realGitFinderHost()` | function | The machine the process runs on, as a `GitFinderHost` |
| `GitFinderHost` | type | The platform, environment, PATH lookup, file check and program run the finder uses; a test passes its own |
