---
description: Every OPERAD_ environment variable and the other variables operad reads, with defaults and when each applies.
---

# Environment variables

Every `OPERAD_*` variable that `operad` or its scripts read, or that a command it
starts receives, and the other variables `operad` reads. [config.json](config.md)
holds the settings that belong in a file; use the environment for a value that
changes per shell or per check host.

The tables give the type, the default, the values accepted and when the value is
read. A value outside the allowed set is either ignored or refused with the
message named in the row.

## What you set

| Variable | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `OPERAD_HOME` | path | `~/.operad` | A directory path | Every command: the home that holds `config.json`, the store, the secrets directory, `tui.json`, `keys.json`, `serve.lock` and `access-user.json`. A relative path is resolved from the current directory. |
| `OPERAD_SERVE_INTERVAL_MS` | integer | `1000` | milliseconds, more than 0 | When `operad serve` starts: the time between loop passes. A value that is not a finite positive number falls back to 1000. |
| `OPERAD_BIND_RETRY_MS` | integer | `10000` | milliseconds, more than 0 | When a `serve` that took over from another one opens its addresses: how long it keeps trying. A first start fails at once. A value that is not a positive number falls back to 10000. |
| `OPERAD_BIND_RETRY_STEP_MS` | integer | `250` | milliseconds, more than 0 | The wait between two tries of the same retry. A value that is not a positive number falls back to 250. |
| `OPERAD_RELOAD_QUIET_MS` | integer | `1000` | milliseconds, more than 0 | How long the files must be quiet before `serve` checks that changed code loads (see [Changed code](cli.md#changed-code)). A value that is not a positive number falls back to 1000. |
| `OPERAD_RELOAD_POLL_MS` | integer | `5000` | milliseconds, more than 0 | How often `serve` looks at the files for a change, and how often a run's process waits for code that does not load. A value that is not a positive number falls back to 5000. |
| `OPERAD_CHECK_BASE` | commit | the merge base of `HEAD` and `origin/main` | A commit name | When `check-changed.sh` picks the packages a change touches: the commit it compares with. A name git cannot resolve stops the script. |
| `OPERAD_CHECK_HOST` | ssh destination | unset: the check runs here | `user@host` | When `remote-check.sh` runs a command: with it set, the command runs on that host. Empty means here. |
| `OPERAD_CHECK_SLOTS` | integer | `1` | whole number, 1 or more | How many task checks run at once on the host; each slot has its own lock and tree. Any other value stops the script with a message that names the variable. |
| `OPERAD_CHECK_LANE` | string | unset | `integration` | `integration` takes the one integration slot instead of a task slot; any other value stops the script with a message that names the variable. |
| `OPERAD_CHECK_TREE` | path | `Code/operad` | A path relative to the host's home | The clone on the host the checks run in; every other slot uses a worktree of it. |
| `OPERAD_CHECK_PATH` | list of directories | `$HOME/.bun-operad/bin:$HOME/.bun/bin` | Directories separated by `:` | Put first on the host's `PATH` before the check line runs, expanded on the host. |
| `OPERAD_CHECK_SSH` | command | `ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4` | An ssh command line | When a check connects to its host. |
| `OPERAD_CHECK_SCP` | command | `scp -q -o BatchMode=yes` | An scp command line | When a check copies the bundle to its host. |
| `OPERAD_TEST_PARALLEL` | integer | `2` | whole number, 1 or more | When `run-tests.sh` starts: how many worker processes run test files. Any other value stops the script with `run-tests: OPERAD_TEST_PARALLEL must be a whole number of 1 or more, not '<value>'`. |
| `OPERAD_TEST_TIMES` | path | `~/.operad-test-times` | A file path | Where each full test run appends one line of timings (`run-tests.sh` and `test-times.ts`). |

## What operad sets

These are set for a command operad starts. Do not set them yourself; a value you
set is replaced or removed.

| Variable | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `OPERAD_ID` | string | always set | The waiting object's id, as `<type>:<id>` | In the environment of the [notify command](notifications.md). |
| `OPERAD_TITLE` | string | always set | The object's title, or its id when the title cannot be read | In the environment of the notify command. |
| `OPERAD_REASON` | string | always set | The question or reason it waits | In the environment of the notify command. |
| `OPERAD_LINK` | string | always set | An `operad://objects/<id>` link | In the environment of the notify command (see [Links](http.md#links)). |
| `OPERAD_TASK` | string | always set | A task id | In the environment of a `dev` cleanup or integration command. |
| `OPERAD_WORKTREE` | path | always set | The task's worktree | In the environment of a `dev` cleanup or integration command. |
| `OPERAD_REMOTE` | string | always set | The remote's name | In the environment of a `dev` cleanup or integration command. |
| `OPERAD_RUN` | string | always set | `<run id>:<step>` | In the environment of a step's process: it names the run and the step, so `serve` can find what a step left running. A child that removes it is not reaped. |
| `OPERAD_RUN_HOME` | path | always set | The home path | In the environment of a step's process, so two homes never meet. |
| `OPERAD_SERVE_SUPERVISED` | flag | not set | `1` | Set by the process that restarts `serve` on changed code; removed before the child sees its own environment. Do not set it yourself. |
| `OPERAD_SERVE_REPLACES` | flag | not set | `1` | Set on a `serve` that a stuck one started in its place; removed before the child sees its own environment. Do not set it yourself. |

## Other variables operad reads

| Variable | Type | Default | Allowed values | When it takes effect |
|---|---|---|---|---|
| `EDITOR` | command | unset | An editor command line | `operad dev task edit`, when stdin is a terminal or carries no brief: the editor opens the current brief. It is run through `/bin/sh -c '<editor> "$1"'`. A non-zero exit fails the command with `"<editor>" exited with code <n>`. |
| `VISUAL` | command | unset | An editor command line | Used only when `EDITOR` is unset or empty. |
| `HOME` | path | the account's home | A directory path | The default home (`~/.operad`), `~` expansion, and the radian config path. |
| `PATH` | list of directories | the account's `PATH` | Directories separated by `:` | Finding `radian`, `pi`, `claude`, git and the other programs a command starts. A command named without a `/` must be on `PATH`. |
| `RADIAN_CONFIG` | path | `$HOME/.radian/config/config.toml` | A file path | The radian harness reads its own provider settings from this file. |
| `BASH_ENV` | path | unset | A file path | The pi worker deletes it from its own environment before it starts, so a shell startup file cannot change a tool call. |
| `ENV` | path | unset | A file path | Deleted by the pi worker for the same reason. |
| `TMPDIR` | path | the system temporary directory | A directory path | Passed to a bot's MCP server, so the server can find temporary files. |
| `LANG` | string | unset | A locale name | Passed to a bot's MCP server. |
| `STRESS_LOCK` | path | `$HOME/.operad-stress.lock` | A directory path | `scripts/stress.sh`: the lock shared by every stress run on the machine. Only a run that knows it is alone passes `--no-lock`. |
| `NODE_ENV` | string | unset | `test` | Internal: the plugin registry leaves out a test-only check when it is `test`. Do not set it for normal use. |
