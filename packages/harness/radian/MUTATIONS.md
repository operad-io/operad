# Mutation records — `harness-radian`

Rows whose mutation broke code in `packages/harness/radian/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

## TK0002 — reviewer fallback and retry

| id | file | mutation | failing test |
|---|---|---|---|
| TK0002-M14 | packages/harness/radian/src/index.ts | `parseResult` dropped the Result's `model_error` | `harness-radian/agent > a Result record's model_error is passed through as data` and `dev/review hardening > a radian Result with a model_error makes the real harness report unavailable` |

## TK0014 — the shared harness process helper

| id | file | mutation | failing test |
|---|---|---|---|
| TK0014-M2 | packages/harness/radian/src/index.ts | mapped radian's `ToolExecutionStarted` to `"tool-end"` | `harness-radian/agent > an open tool call pauses the stall timer until it settles` |

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M1 | packages/harness/radian/src/index.ts | skipped the non-zero exit check, so exit 1 became `done` | `harness-radian/agent > a non-zero exit is a failure that says so` |
| TK0018-M2 | packages/harness/radian/src/index.ts | defaulted an absent Result cost to `{ micros: 0 }` instead of `null` | `harness-radian/agent > a Result record without a cost leaves the cost unknown, not zero` |
| TK0018-M3 | packages/harness/radian/src/process.ts | marked the wall-time stop as a stall | `harness-radian/agent > wallTimeSecs stops a run that never ends` (removed) |
| TK0018-M4 | packages/harness/radian/src/index.ts | sent a 1 MB prompt through argv instead of stdin | `harness-radian/agent > a prompt over 1 MB goes through stdin unchanged` |
| TK0018-M6 | packages/harness/radian/src/process.ts | skipped the PATH lookup, so a missing radian became a spawn failure | `harness-radian/agent > a radian that is not on PATH fails with a clear reason` (removed) |
| TK0018-M7 | packages/harness/radian/src/index.ts | treated a zero exit without a Result as success | `harness-radian/agent > a zero exit without a Result record is a failure that says so` |
| TK0018-M8 | packages/harness/radian/src/index.ts | classified a cancelled run as a failure instead of `interrupted` | `harness-radian/agent > cancel stops the process group and reports interrupted` |
| TK0018-M9 | packages/harness/radian/src/process.ts | stopped resetting the stall timer on each output line | `harness-radian/agent > no new output line for stallSecs stops the group` (removed) |
| TK0018-M10 | packages/harness/radian/src/process.ts | `finish()` waited only for `exit`, which a failed spawn never emits | `harness-radian/agent > a spawn failure after the cwd check settles as a failure, not a hang` (timed out after 5000ms) (removed) |
| TK0018-M11 | packages/harness/radian/src/process.ts | multiplied the longest-line bound by 1024, removing any practical bound on an unterminated stream | `harness-radian/agent > an unterminated output stream is stopped, not buffered forever` (never settled; the buffer kept growing) (removed) |
| TK0018-M12 | packages/harness/radian/src/index.ts | recorded an over-long line as a signal exit instead of `line_too_long` | `harness-radian/agent > an unterminated output stream is stopped, not buffered forever` (`exit` instead of `line_too_long`) |
| TK0018-M13 | packages/harness/radian/src/jsonl-log.ts | `push` flushed a full buffer without returning the pending write, so the caller never waited | `jsonl log > a full buffer returns the write the caller must wait for` (removed) |
| TK0018-M14 | packages/harness/radian/src/process.ts | `Lines.push` delivered every line of a chunk without waiting for the line handler | `harness-radian/agent > a line handler that is still busy stops the reader from reading ahead` (removed) |
| TK0027-M5 | packages/harness/radian/src/index.ts | dropped the event note from a triggered prompt | `harness-radian:prompt > a trigger with summary and data appends one note that names both files` |
| TK0012-M5 | packages/harness/radian/src/process.ts | stopped pausing the stall timer while a tool call was open | `harness-radian/agent > an open tool call pauses the stall timer until it settles` (removed) |
| bun-fd-guard-M1 | packages/harness/radian/src/process.ts | the old code: the sentinel's `stdio` had a fourth pipe and the harness stderr went to `child.stdio[3]` | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (child exits 137, 3 of 3 runs) (removed) |
| bun-fd-guard-M2 | packages/harness/radian/src/process.ts | the stderr tail was not read back from the file (`stderrTail.push("")`) | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (tails `[""]` instead of `["oops"]`) (removed) |
| bun-fd-guard-M3 | packages/harness/radian/src/process.ts | the fixed code with `stdio` set back to four pipes, the fourth one unused | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (child exits 137) (removed) |
| bun-fd-guard-M4 | packages/harness/radian/src/process.ts | `stdio` set back to four pipes | `child process stdio > no source spawns with more than three stdio entries or reads stdio[3] or higher` (names `packages/harness/radian/src/process.ts:434` and bf3a73e) (removed) |
| TK0009-M8 | packages/harness/radian/test/support.ts | `processesUnder` returned nothing | `the guard sees a process whose command line names a temp directory` |
| T-0021-M10 | packages/harness/radian/src/index.ts | the limit key used the model alone, without `--provider` | `harness-radian/agent step limit > the key is harness-radian:<provider>/<model> from the step's args` |
| T-0022-M6 | packages/harness/radian/src/index.ts | the usage dropped radian's cost (`costMicros: null`) | `harness-radian/agent > a successful run records the Result record and writes the JSONL log` |
| T-0022-M8 | packages/harness/radian/src/index.ts | `parseResult` dropped radian's `incomplete` flag | `harness-radian/agent > an incomplete or estimated cost says so in the usage` |
| T-0022-M9 | packages/harness/radian/src/index.ts | `radianModel` prefixed a model that already names its provider | `harness-radian/agent > a model that already names its provider is not prefixed again` |
| T-0025-M8 | `packages/harness/radian/src/index.ts` | the step ran radian when the profile had a one-time permission it cannot enforce | `harness-radian/agent > a one-time permission is refused before radian runs, naming radian` |
| T-0025-M14 | `packages/harness/radian/src/index.ts` | a resumed run that answered with another session was accepted | `harness-radian/agent > a resumed run that answers with another session fails as session_missing` |
| T-0063-M1 | packages/harness/radian/src/index.ts | `radianLogLine` returned radian's raw line instead of the rewritten one | `harness-radian/agent > tool lines carry the command summary, the duration and an error's first line` |
| T-0063-M2 | packages/harness/radian/src/index.ts | `radianLogLine` summarized with an empty profile instead of the run's | `harness-radian/agent > a tool call the access profile refuses is only said to be denied in the log` |
| T-0063-M3 | packages/harness/radian/src/index.ts | `radianLogLine` ignored the store secrets | `harness-radian/agent > a secret of the operad store is masked in the logged command` |
| T-0063-M4 | packages/harness/radian/src/index.ts | `radianLogLine` logged the settled error of a denied call | `harness-radian/agent > a denied call's settled error is not logged` |
| T-0063-M35 | packages/harness/radian/src/index.ts | the settled line ignored `data.result.is_error` and its content text | `radian's nested failure result logs isError and its first error line` |
| T-0063-M36 | packages/harness/radian/src/index.ts | radian's `shell`, `patch` and `glob` were summarized under their own names, so the access profile did not judge them | `radian's own tool names are judged by the access profile: shell, patch, glob, list, other path tools` |
| T-0172-M1 | packages/harness/radian/test/support.ts | the marker wait returned to depending on a directory watch alone, so a watch armed after the marker was written never saw it | `a marker wait survives a directory that appears after it starts` |
| T-0188-M13 | packages/harness/radian/src/index.ts | radian was not given the MCP config | `harness-radian/agent > operad's tools are given to radian as an MCP config that starts the tools program with the home` |
| T-0188-M23 | packages/harness/radian/src/index.ts | a refused tool call did not end the run | `harness-radian/agent > a read-only working directory > a radian chat whose agent tries to write a file is refused with a reason, and the run ends` |
| T-0188-M26 | packages/harness/radian/src/index.ts | radian was not given the config that runs the profile's hook (replaces the run-ending check of T-0188-M23, which is gone) | `in radian itself a read-only profile stops the write tool before it runs, and without one the same call writes` |
| T-0188-M27 | packages/harness/radian/src/hook.ts | the hook exited 0 for a call the profile refuses | `the hook program denies with exit 2 and the reason for a write, a command that writes and a denied path` |
| T-0188-M29 | packages/harness/radian/src/refusal.ts | a `patch` was judged only on its own `path`, not on the paths of its edits | `the hook program denies a patch in every form, an unknown tool and a user's MCP tool in a read-only directory` |
| T-0188-M30 | packages/harness/radian/src/refusal.ts | a read-only directory let an unknown tool (a user's MCP server) run | `the hook program denies a patch in every form, an unknown tool and a user's MCP tool in a read-only directory` |

## T-0240 — rework: multi-line log commands and code spans

| id | file | mutation | failing test |
|---|---|---|---|
| T-0240-M10 | packages/harness/radian/src/index.ts | the logged shell command no longer kept its line breaks (`keepLines` removed) | `harness-radian/agent > a multi-line command keeps its lines in the logged summary` |

## T-0300 — the wall test read a marker before its pid was written

| id | file | mutation | failing test |
|---|---|---|---|
| T-0300-M1 | packages/harness/radian/test/plugin.test.ts | the wall test read the marker with `Number(readFileSync(...))` instead of `waitForPid`, so a read between the file's creation and its write took pid 0, which `kill -0` always finds | `radian/agent > wallTimeSecs stops a run that never ends` (the wait after the run throws after 2 s); on macOS the directory watch coalesces the create and the write, so this needs the marker created empty and filled later, as Linux's inotify does |
| T-0300-M2 | packages/harness/radian/test/support.ts | `waitForJson` parsed the marker once, so an empty file threw instead of being read again | `a marker wait reads JSON only once the file holds it` |


## T-0342 — a chat's effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0342-M9 | packages/harness/radian/src/index.ts | the plugin stopped declaring the empty effort list | `the efforts radian declares > none: it cannot honour an effort a chat picks` |
| T-0327-M12 | packages/harness/radian/src/refusal.ts | radian let an unlisted MCP tool run | `radian/agent > radian refuses another server's tool unless the profile lists it: it cannot ask` |
| T-0327-M13 | packages/harness/radian/src/index.ts | radian was not given a bot's MCP servers | `radian/agent > a bot's servers are written to radian's MCP config by name, with operad's server kept` |
