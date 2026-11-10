# @operad-io/shell

The base `stage` plugin. It provides `shell/command`, which runs one shell
line; `shell/check`, which runs a list of lines and stops at the first failure;
and `shell/probe`, which a time or condition wait can call.

## `shell/check` result data

`shell/check` ends as `pass`, `fail` or `interrupted`. Its result's `data`:

| field | when | meaning |
|---|---|---|
| `log` | always | the step log's path |
| `logStart` | always | the byte offset in `log` where this invocation's output starts; a caller reading this invocation's output starts here, so output an earlier invocation wrote to the same run log is left out |
| `tail` | always | the last output lines |
| `lines` | on `pass` | how many lines ran |
| `line`, `lineNumber` | when the check stops on a line | that line and its 1-based position in `params.lines` |
| `exitCode`, `signal` | when the outcome has them | how the line's command ended |
| `reason` | on `fail` and `interrupted` | `cwd`, `spawn`, `timeout`, `signal`, `exit` or `cancelled` |
| `message` | when the outcome has one | the human text for the failure |

The log is the kernel logger's file for the step and run. It is appended to
across every visit of the step in that run, so an earlier visit's output stays
before `logStart`.
