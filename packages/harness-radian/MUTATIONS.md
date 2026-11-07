# Mutation records — `harness-radian`

Rows whose mutation broke code in `packages/harness-radian/`, in the order they were
recorded. The root [MUTATIONS.md](../../MUTATIONS.md) explains the format and
the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| TK0018-M1 | packages/harness-radian/src/index.ts | skipped the non-zero exit check, so exit 1 became `done` | `harness-radian/agent > a non-zero exit is a failure that says so` |
| TK0018-M2 | packages/harness-radian/src/index.ts | defaulted an absent Result cost to `{ micros: 0 }` instead of `null` | `harness-radian/agent > a Result record without a cost leaves the cost unknown, not zero` |
| TK0018-M3 | packages/harness-radian/src/process.ts | marked the wall-time stop as a stall | `harness-radian/agent > wallTimeSecs stops a run that never ends` |
| TK0018-M4 | packages/harness-radian/src/index.ts | sent a 1 MB prompt through argv instead of stdin | `harness-radian/agent > a prompt over 1 MB goes through stdin unchanged` |
| TK0018-M6 | packages/harness-radian/src/process.ts | skipped the PATH lookup, so a missing radian became a spawn failure | `harness-radian/agent > a radian that is not on PATH fails with a clear reason` |
| TK0018-M7 | packages/harness-radian/src/index.ts | treated a zero exit without a Result as success | `harness-radian/agent > a zero exit without a Result record is a failure that says so` |
| TK0018-M8 | packages/harness-radian/src/index.ts | classified a cancelled run as a failure instead of `interrupted` | `harness-radian/agent > cancel stops the process group and reports interrupted` |
| TK0018-M9 | packages/harness-radian/src/process.ts | stopped resetting the stall timer on each output line | `harness-radian/agent > no new output line for stallSecs stops the group` |
| TK0018-M10 | packages/harness-radian/src/process.ts | `finish()` waited only for `exit`, which a failed spawn never emits | `harness-radian/agent > a spawn failure after the cwd check settles as a failure, not a hang` (timed out after 5000ms) |
| TK0018-M11 | packages/harness-radian/src/process.ts | multiplied the longest-line bound by 1024, removing any practical bound on an unterminated stream | `harness-radian/agent > an unterminated output stream is stopped, not buffered forever` (never settled; the buffer kept growing) |
| TK0018-M12 | packages/harness-radian/src/index.ts | recorded an over-long line as a signal exit instead of `line_too_long` | `harness-radian/agent > an unterminated output stream is stopped, not buffered forever` (`exit` instead of `line_too_long`) |
| TK0018-M13 | packages/harness-radian/src/jsonl-log.ts | `push` flushed a full buffer without returning the pending write, so the caller never waited | `jsonl log > a full buffer returns the write the caller must wait for` |
| TK0018-M14 | packages/harness-radian/src/process.ts | `Lines.push` delivered every line of a chunk without waiting for the line handler | `harness-radian/agent > a line handler that is still busy stops the reader from reading ahead` |
| TK0027-M5 | packages/harness-radian/src/index.ts | dropped the event note from a triggered prompt | `harness-radian:prompt > a trigger with summary and data appends one note that names both files` |
| TK0012-M5 | packages/harness-radian/src/process.ts | stopped pausing the stall timer while a tool call was open | `harness-radian/agent > an open tool call pauses the stall timer until it settles` |
| bun-fd-guard-M1 | packages/harness-radian/src/process.ts | the old code: the sentinel's `stdio` had a fourth pipe and the harness stderr went to `child.stdio[3]` | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (child exits 137, 3 of 3 runs) |
| bun-fd-guard-M2 | packages/harness-radian/src/process.ts | the stderr tail was not read back from the file (`stderrTail.push("")`) | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (tails `[""]` instead of `["oops"]`) |
| bun-fd-guard-M3 | packages/harness-radian/src/process.ts | the fixed code with `stdio` set back to four pipes, the fourth one unused | `harness process descriptors > running 30 harness commands next to open databases never closes a descriptor twice` (child exits 137) |
| bun-fd-guard-M4 | packages/harness-radian/src/process.ts | `stdio` set back to four pipes | `child process stdio > no source spawns with more than three stdio entries or reads stdio[3] or higher` (names `packages/harness-radian/src/process.ts:434` and bf3a73e) |
| T-0021-M10 | packages/harness-radian/src/index.ts | the limit key used the model alone, without `--provider` | `harness-radian/agent step limit > the key is harness-radian:<provider>/<model> from the step's args` |
