---
description: Setup Dev: have your bot read a repository and propose the settings that turn dev on for it.
---

# Setup Dev

Setup Dev (配置开发流程) turns operad's dev on for one repository. A new home starts as the personal assistant and leaves `dev`, `shell` and `pool` off; Setup Dev has your bot read the repository's CI and scripts and propose what to turn on. Nothing changes until you approve it.

Start it in any of these ways:

- Say it in a bot chat: "set up dev for ~/code/myrepo". The bot's agent knows how to propose it.
- Type `/setup dev ~/code/myrepo` in a bot chat. Every plugin that ships a setup guide has its own Setup <name> this way; `dev` is the first.
- Run the bot's Setup Dev action from the new-object entry, giving the repository's directory, which opens a bot chat that starts with the prepared prompt below. On the command line: `operad bot:setup-dev <bot> --path <repository directory>`.

The bot reads the repository and runs its checks under the chat's access level, so it asks as any chat does (see [access](access.md)); Setup Dev gives it no extra permission. It does not write `.operad/dev.json` itself. It proposes, and you see one pending item for the repository. `Review` shows the plugins that would be turned on (`dev`, `shell` and `pool`, those that are off), the `.operad/dev.json` that would be written and, when there is one, the file it replaces. `approve` turns the plugins on, writes the file and registers the repository, so `operad dev repo list` shows it a moment later, after `serve` reloads. `reject` changes nothing.

The repository must be the root of a git work tree that has a remote. Every key the bot may write is described in [dev](dev.md). Read what it proposes before you approve it: the checks in `gate.commands` judge whether a change is good enough to reach review, so they should be the ones you trust. Commit `.operad/dev.json` afterwards; operad reads it from the main clone.

This is the prompt the bot is given, with the bot and the directory filled in:

```text
Set up operad's dev for the repository at <repository directory>. dev is operad's way of running coding
agents through verified flows (plan, work, verify, review, merge). Your job is to write a
correct `.operad/dev.json` for this repo and propose it. Do not change source code, do not
write the file yourself, do not commit, push or start anything. Reply in the language I write
to you in.

Reference, if you need a key's details: https://operad.io/docs/dev/ (the full key table)
and https://operad.io/llms.txt.

1. Look at the repository. Run `git remote -v` and find the main branch name in <repository directory>.
   The repository needs a git remote; if it has none, say so and stop. Check which agents
   are on PATH: `claude`, `pi`, `radian`. When none is, operad's own pi is the agent.

2. Find this repo's checks. Read CI config (.github/workflows, .gitlab-ci.yml, ...), the
   Makefile, package.json scripts, pyproject, Cargo.toml or whatever applies. Choose the
   commands that CI runs to judge whether a change is good: tests, typecheck, lint, build.
   Each must exit non-zero on failure. Order them fast to slow. Run each once on the
   current checkout; if one already fails on main, tell me instead of hiding it. If the
   repo has no checks, say so and leave `gate.commands` empty.

3. Find what a fresh checkout needs. Each task runs in its own git worktree, so dependencies
   are not there. Put the install step in `prepare` (for example
   `bun install --frozen-lockfile` or `npm ci`), only if the repo needs one.

4. Write the `.operad/dev.json` text. Use only keys that matter; keep it small. Use the
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

5. Propose it. Call the operad `command` tool with plugin `bot`, verb `setup-dev`,
   arguments `default` and `<repository directory>`, and the `.operad/dev.json` text as its input. It makes
   a pending item; nothing is turned on or written until I approve it in Pending. If it
   refuses, fix what it names and call it again.

6. Report. Show me the `.operad/dev.json` you proposed, say in one line why you chose each
   check command, worker and reviewer, and list anything you were unsure about. Tell me
   to commit `.operad/dev.json` after I approve it (operad reads it from the main clone).
```

When you are ready, the next steps are `operad serve`, then `operad dev plan add --slug <slug> --title "<title>" < request.md`.
