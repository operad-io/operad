<p align="center"><b>English</b> · <a href="README.zh-CN.md">中文</a></p>

<p align="center">
<img alt="operad" src="docs/assets/logo-light.png#gh-light-mode-only" width="320">
<img alt="operad" src="docs/assets/logo-dark.png#gh-dark-mode-only" width="320">
</p>

<p align="center"><b>An open orchestration layer for coding agents.</b><br>
Run any agent through verified flows: plan, work, verify, review, merge.</p>

<p align="center">
<a href="https://www.npmjs.com/package/@operad-io/cli"><img alt="npm" src="https://img.shields.io/npm/v/@operad-io/cli?label=%40operad-io%2Fcli"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
<a href="https://operad.io"><img alt="website: operad.io" src="https://img.shields.io/badge/website-operad.io-5672b3"></a>
<a href="https://x.com/zyinghai"><img alt="X: @zyinghai" src="https://img.shields.io/badge/%40zyinghai-000000?logo=x&logoColor=white"></a>
</p>

---

operad runs coding agents (radian, Claude Code, Codex, pi and others) through flows that check their work, keeps what happened as history, and reaches you where a person is needed. You see three things:

- **flow**: the path a piece of work follows.
- **pending**: everything that waits for you, in one list, with the actions each item offers.
- **history**: what each step did, and why.

Everything else is a plugin.

```text
$ operad pending
4c1e9a02  dev  confirm
  Rotate the http token
  waiting: ready to merge
  actions: dev:merge, dev:reject, dev:rework,
           dev:reverify, dev:cancel

$ operad dev:merge T-0022-token-rotate --yes
```

## Install

operad runs on [Bun](https://bun.com); install Bun first. Then:

```sh
bun add -g @operad-io/cli
operad --help
```

`npm install -g @operad-io/cli` also works while `bun` is on your `PATH`.

You also need `git`, a repository with a remote, and one of `claude`, `pi` or `radian` on your `PATH`.

## Quickstart

```sh
operad init                     # create the home and check the plugins
operad repo add .               # register this repository
operad plan add --slug hello --title "Add a greeting" < request.md
operad task add --plan P-0001-hello --slug greet --title "Print the greeting" < task.md
operad dev:confirm P-0001-hello
operad serve                    # run the loop

operad pending                  # what waits for you
operad dev:merge T-0001-greet --yes
```

Not sure what goes in `.operad/dev.json`? [Paste this prompt](docs/user/setup-prompt.md) into your coding agent and it will write and check the file for you.

## How it works

1. **You ask.** Describe a request with `operad plan add`, split it into tasks with `operad task add`, then confirm the plan.
2. **An agent works.** Each task gets its own git worktree and a brief. The worker commits there.
3. **Checks run.** The commands you list in `.operad/dev.json` run against the commit.
4. **An agent reviews.** A reviewer reads the change and writes a report. Findings send the task back for rework, up to a limit.
5. **You merge.** The task waits in pending. Merge lands it on main; reject sends it back with your note.

Any agent can work and any agent can review. Pick them per repository:

```jsonc
// .operad/dev.json
{
  "workers":  { "claude": { "use": "claude/agent", "args": ["--model", "sonnet"] } },
  "reviewer": { "use": "pi/agent",     "args": ["--thinking", "medium"] }
}
```

## Where you use it

- **Terminal.** `operad tui` lists what is pending and running and opens an object beside the list. See [the terminal client](docs/user/tui.md).
- **Claude Code.** `operad mcp` is an MCP server on stdio. A lead agent reads pending, running and history and takes the actions `config.json` allows, but never takes your decision: merge stays with you. See [MCP](docs/user/mcp.md).
- **iPhone.** Run `operad pair` and scan the code. The app shows pending, running and each object's history, and asks before it merges. See [the app](docs/user/app.md).

## Plugins

The kernel knows three words. The rest is plugins: `dev` (plans, tasks, review, merge), `chat` (a long conversation with an agent), `bot` (a directory, an agent, skills) and `pool` (shared limits for each agent). A plugin is a TypeScript file, loaded without a build step, small enough for an agent to write on the spot, and `operad plugin check` type-checks it before it runs. Start at [Writing a plugin](docs/plugins/index.md).

## Documentation

- [User manual](docs/user/index.md): quickstart, `config.json`, the `dev` plugin, access profiles, every command, troubleshooting.
- [Writing a plugin](docs/plugins/index.md): for plugin authors.
- [docs/backlog/](docs/backlog/): the direction and the open questions.
- [CONTRIBUTING.md](CONTRIBUTING.md) to help; [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## Status

operad is in development. Expect rough edges and changes.

## Packages

The packages are published under `@operad-io`. Most people install only `@operad-io/cli`; the others come with it or are turned on from it.

| package | what it is |
|---|---|
| [`cli`](packages/cli) | the `operad` command |
| [`engine`](packages/engine) | the kernel: flows, pending, history, and the plugin API |
| [`dev`](packages/dev) | plans and tasks on a repository, to a merge |
| [`shell`](packages/shell) | shell command and check steps |
| [`chat`](packages/chat), [`bot`](packages/bot) | a conversation with an agent; a directory, an agent and skills |
| [`pool`](packages/pool) | workers shared by runs |
| [`tui`](packages/tui), [`mcp`](packages/mcp) | the terminal client; the MCP server |
| [`harness/claude`](packages/harness/claude), [`harness/codex`](packages/harness/codex), [`harness/pi`](packages/harness/pi), [`harness/radian`](packages/harness/radian) | the agents operad can run |
| [`harness/process`](packages/harness/process) | helpers shared by the harnesses |
| [`access-match`](packages/access-match), [`review-grading`](packages/review-grading) | access profiles for tool calls; review grading |

Each package has a short README that points back here. The longer notes for developers are in a `REFERENCE.md` beside it.

## License

MIT; see [LICENSE](LICENSE).
