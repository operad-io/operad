---
description: A prompt that has your coding agent write and check .operad/dev.json for a repository.
---

# Set up operad with an agent

Paste the prompt below into your coding agent (Claude Code, pi, radian or another) from the root of the repository you want operad to work on. The agent reads the repository's CI and scripts, writes `.operad/dev.json`, registers the repository, and tells you what it chose. It changes no source code and does not commit, push or start `operad serve`.

You need operad installed first: `bun add -g @operad-io/cli` (see the [quickstart](quickstart.md)). Every key the agent may write is described in [dev](dev.md).

```text
Set up operad for this repository. operad is an orchestration layer that runs coding
agents through verified flows (plan, work, verify, review, merge). Your job is to write
a correct `.operad/dev.json` for this repo and register it. Do not change source code.
Reply in the language I write to you in.

Reference, if you need a key's details: https://operad.io/docs/dev/ (the full key table)
and https://operad.io/llms.txt.

1. Check what is installed. Run `operad --help` (if it is missing, tell me to run
   `bun add -g @operad-io/cli` and stop). Check which agents are on PATH: `claude`,
   `pi`, `radian`. Check `git remote -v` and the main branch name. The repository
   needs a git remote; if it has none, say so and stop.

2. Find this repo's checks. Read CI config (.github/workflows, .gitlab-ci.yml, ...),
   the Makefile, package.json scripts, pyproject, Cargo.toml or whatever applies.
   Choose the commands that CI runs to judge whether a change is good: tests, typecheck,
   lint, build. Each must exit non-zero on failure. Order them fast to slow. Run each
   once on the current checkout; if one already fails on main, tell me instead of
   hiding it. If the repo has no checks, say so and leave `gate.commands` empty.

3. Find what a fresh checkout needs. Each task runs in its own git worktree, so
   dependencies are not there. Put the install step in `prepare` (for example
   `bun install --frozen-lockfile` or `npm ci`), only if the repo needs one.

4. Write `.operad/dev.json`. Use only keys that matter; keep it small. Use the
   `workers` form, never the old `worker` form:

   {
     "name": "<repo name>",
     "remote": "<remote>",
     "mainBranch": "<main branch>",
     "workers": { "<agent>": { "use": "<agent>/agent", "args": [] } },
     "prepare": [ ... ],
     "gate": { "commands": [ ... ], "commandTimeoutSecs": 1800 },
     "reviewer": { "use": "<agent>/agent", "args": [] },
     "autoDefault": "off"
   }

   - Workers and reviewer: use agents that are actually installed. If two or more are
     installed, use a different one for the reviewer than for the worker. `use` is
     `<plugin>/<step>`, such as `claude/agent`, `pi/agent`, `radian/agent`.
   - Leave `autoDefault` at "off": nothing merges without me.
   - Do not invent model names or flags. Leave `args` empty unless I give you some.

5. Register and verify. Run `operad plugin enable pool` (the dev flow needs it), then
   `operad init` and `operad repo add .`. Read every line they print. If a command
   refuses a field, fix the file using the field path in the message and run it again.
   `operad pending` must not show an invalid-settings item for this repo.

6. Report. Show me the final `.operad/dev.json`, say in one line why you chose each
   check command, worker and reviewer, and list anything you were unsure about. Tell
   me to commit `.operad/dev.json` (operad reads it from the main clone). Do not
   commit, push, start `operad serve` or create plans yourself.

When I am ready, the next steps are `operad serve`, then
`operad plan add --slug <slug> --title "<title>" < request.md`.
```

Read what the agent wrote before you commit it. The checks in `gate.commands` judge whether a change is good enough to reach review, so they should be the ones you trust.
