---
description: Terminals that operad serve keeps: any command or a shell in a repository or a worktree, from this Mac only.
---

# Terminals

A terminal runs a command in a folder and is kept by `operad serve`, so it goes
on when you close the window that shows it. Use one for a dev server in a task's
worktree, a shell in a project's folder, or an agent's own screen. This page has
what a terminal does; its routes and events are on [the HTTP page](http.md#terminals).

## Turn it on

The `terminal` plugin is off until you enable it:

```sh
operad plugin enable terminal
```

Restart `serve` if it does not reload by itself. A client opens terminals over
HTTP, so [`http.enabled`](http.md#the-http-section) must be true. There is no
`operad` command that opens one.

## What you can start

- **Any command line.** It runs in your login shell as `$SHELL -ilc <command>`,
  so it sees the `PATH` and the variables your shell sets up. `TERM` is
  `xterm-256color`.
- **A shell.** An empty command line opens the login shell itself.
- **An agent.** For each enabled harness among `claude`, `codex` and `pi` whose
  agent is on the machine, a client may offer a command line to fill in: the one
  in the harness's `command` setting, the pi operad installed when your `PATH` has
  none, else the agent's name. It is an ordinary command: it uses the agent's own
  screen and login, not an access profile. Flows and chats do not use terminals.

The folder must be a repository you registered with `dev`, or one of its git
worktrees, such as a task's. A folder inside one is refused.

Two worktrees running the same dev server will compete for its port.

## How a terminal ends

A terminal keeps running while no client is connected. It ends when:

| What happens | What you see |
|---|---|
| Its command ends | The terminal stays in the list with its exit code (128 plus the signal number when a signal ended it) until you close it |
| You close it | Everything it started is stopped, and it leaves the list |
| Its folder is removed | It is stopped, and says `stopped because its folder was removed` |
| `serve` stops or restarts | Every terminal ends and the new `serve` lists none, also when `serve` restarts by itself to load changed code |

What a command leaves running, such as a background job, keeps running after
the terminal ended. Closing the ended terminal, removing its folder or stopping
`serve` stops it. A program that made itself a daemon is left alone, and on
macOS a job made only of the system's own programs is not found.

When `dev` cleans up a task after a merge, the terminals in the task's worktree
are stopped before the worktree is removed. Those in a task's checking worktree
are also stopped when `dev` makes that worktree again. A cancelled or rejected task keeps
its worktree, and its terminals keep running. A folder you remove yourself is
noticed within about a second.

A cleanup command of your own in [`dev.hooks.afterMerge`](dev.md#work-review-integration-and-cleanup)
stops them first when it names `$OPERAD_WORKTREE` or runs `git worktree remove`.

## Coming back

A client that connects again gets the screen and up to 5000 lines above it, then
the new output. When a program prints far faster than it can be read, some of its
output is left out, and the log of `serve`'s `terminal` plugin says so.

## This Mac only

A terminal is a shell on your machine. Starting one, typing in it, resizing,
closing, any other change and reading its screen work only from the machine
`serve` runs on, over loopback (`http://127.0.0.1:<port>`). A request from your
network or your tailnet, also one passed on by a proxy on your machine, is
refused. Another device may still read the list, with each terminal's command
line, folder and state. It needs the token like any request.
