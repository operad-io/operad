---
description: Every OPERAD_ environment variable: who reads it, its default and when it takes effect.
---

# Environment variables

Every `OPERAD_*` variable that `operad` or its scripts read, or that a command it starts receives. The first table is what you set; the second is what operad sets for a command it starts. [config.json](config.md) holds the settings that belong in a file.

## What you set

| Variable | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `OPERAD_HOME` | path | `~/.operad` | A directory path | At every command: the home that holds `config.json`, the store, the secrets directory and `access-user.json` (see [config.json](config.md#the-home)). |
| `OPERAD_SERVE_INTERVAL_MS` | integer | the loop's own interval | milliseconds | When `operad serve` starts: the time between loop passes. A value that is not a number is ignored. |
| `OPERAD_BIND_RETRY_MS` | integer | `10000` | milliseconds, `1` or more | When a `serve` that took over from another one opens its addresses: how long it keeps trying. A first start fails at once. |
| `OPERAD_BIND_RETRY_STEP_MS` | integer | `250` | milliseconds, `1` or more | The wait between two tries of the same retry. |
| `OPERAD_RELOAD_QUIET_MS` | integer | `1000` | milliseconds, `1` or more | How long the files must be quiet before `serve` checks that changed code loads (see [Changed code](cli.md#changed-code)). |
| `OPERAD_RELOAD_POLL_MS` | integer | `5000` | milliseconds, `1` or more | How often `serve` looks at the files for a change. |
| `OPERAD_CHECK_BASE` | commit | the merge base of `HEAD` and `origin/main` | A commit name | When a check picks the packages a change touches (see [Checks](checks.md)). |
| `OPERAD_CHECK_HOST` | ssh destination | unset: the check runs here | `user@host` | When a check command runs: with it set, the command runs on that host. |
| `OPERAD_CHECK_SLOTS` | integer | `1` | whole number, `1` or more | How many checks run at once on the host. |
| `OPERAD_CHECK_LANE` | string | unset | `integration` | `integration` takes the integration slot instead of a task slot. |
| `OPERAD_CHECK_TREE` | path | `Code/operad` | A path relative to the host's home | The clone on the host the checks run in. |
| `OPERAD_CHECK_PATH` | list of directories | `$HOME/.bun-operad/bin:$HOME/.bun/bin` | Directories put first on the host's `PATH` | When a check command runs on the host. |
| `OPERAD_CHECK_SSH` | command | `ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4` | An ssh command line | When a check connects to its host. |
| `OPERAD_CHECK_SCP` | command | `scp -q -o BatchMode=yes` | An scp command line | When a check copies to its host. |
| `OPERAD_TEST_PARALLEL` | integer | `2` | whole number, `1` or more | When the test script starts: how many worker processes run test files. |
| `OPERAD_TEST_TIMES` | path | `~/.operad-test-times` | A file path | Where each full test run appends one line of timings. |

## What operad sets

| Variable | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `OPERAD_ID` | string | always set | The waiting object's id | In the environment of the [notify command](notifications.md). |
| `OPERAD_TITLE` | string | always set | The object's title, or its id | In the environment of the notify command. |
| `OPERAD_REASON` | string | always set | The question or reason it waits | In the environment of the notify command. |
| `OPERAD_LINK` | string | always set | An `operad://objects/<id>` link | In the environment of the notify command (see [Links](http.md#links)). |
| `OPERAD_TASK` | string | always set | A task id | In the environment of a `dev` cleanup or integration command. |
| `OPERAD_WORKTREE` | path | always set | The task's worktree | In the environment of a `dev` cleanup or integration command. |
| `OPERAD_REMOTE` | string | always set | The remote's name | In the environment of a `dev` cleanup or integration command. |
| `OPERAD_RUN` | string | always set | `<run id>:<step>` | In the environment of a step's process: it names the run and the step, so `serve` can find what a step left running. |
| `OPERAD_RUN_HOME` | path | always set | The home path | In the environment of a step's process, so two homes never meet. |
| `OPERAD_SERVE_SUPERVISED` | flag | not set | `1` | Set by the process that restarts `serve` on changed code; do not set it yourself. |
| `OPERAD_SERVE_REPLACES` | flag | not set | `1` | Set on a `serve` that a stuck one started in its place; do not set it yourself. |
