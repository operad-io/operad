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

Before it writes the file the bot asks which way you want to work, in your language and in plain words: the agent makes a new branch in your folder and works there one thing at a time (best not to edit the folder meanwhile), or each piece of work gets its own separate folder, so several can go at once and your folder stays untouched. If you are unsure it chooses the first. Your answer becomes `workIn` in the proposed file (see [dev](dev.md#where-a-task-works)).

The repository must be the root of a git work tree. It may have no remote: merges then stay in the local main branch. Every key the bot may write is described in [dev](dev.md). Read what it proposes before you approve it: the checks in `gate.commands` judge whether a change is good enough to reach review, so they should be the ones you trust. Commit `.operad/dev.json` afterwards; operad reads it from the main clone.

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
   A repository with no git remote is fine: leave `remote` out of the file. Check which agents
   are on PATH: `claude`, `pi`, `radian`. When none is, operad's own pi is the agent.

2. Find this repo's checks. Read CI config (.github/workflows, .gitlab-ci.yml, ...), the
   Makefile, package.json scripts, pyproject, Cargo.toml or whatever applies. Choose the
   commands that CI runs to judge whether a change is good: tests, typecheck, lint, build.
   Each must exit non-zero on failure. Order them fast to slow. Run each once on the
   current checkout; if one already fails on main, tell me instead of hiding it. If the
   repo has no checks, say so and leave `gate.commands` empty.

3. Find what a fresh checkout needs. Each task runs in a fresh checkout, so dependencies
   are not there. Put the install step in `prepare` (for example
   `bun install --frozen-lockfile` or `npm ci`), only if the repo needs one.

4. Ask me which way to work, before you write the file. Say it in my language and in plain
   words, about what changes for me; do not use the words clone, worktree or concurrency, and
   do not ask me to know them. Offer two ways:
   - In my folder: the agent makes a new branch in this folder and works there, one thing at
     a time. It is best for me not to edit the folder while it works.
   - Separately: each piece of work gets its own separate folder, so several can go at once
     and my own folder stays untouched.
   If I am not sure, or do not answer, choose the first (a new branch in my folder).

5. Write the `.operad/dev.json` text. Use only keys that matter; keep it small. Use the
   `workers` form, never the old `worker` form:

   {
     "name": "<repo name>",
     "remote": "<remote, left out when the repository has none>",
     "mainBranch": "<main branch>",
     "workIn": "<branch or worktree, from my answer>",
     "workers": { "<agent>": { "use": "<agent>/agent", "args": [] } },
     "prepare": [ ... ],
     "gate": { "commands": [ ... ], "commandTimeoutSecs": 1800 },
     "reviewer": { "use": "<agent>/agent", "args": [] },
     "autoDefault": "off"
   }

   - Workers and reviewer: use agents that are actually installed. If two or more are
     installed, use a different one for the reviewer than for the worker. `use` is
     `<plugin>/<step>`, such as `claude/agent`, `pi/agent`, `radian/agent`.
   - `workIn` is `"branch"` for the first way and `"worktree"` for the second. Never write
     those two words to me; they belong only in the file. With `"branch"`, leave out
     `concurrency` (it is one at a time).
   - Leave `autoDefault` at "off": nothing merges without me.
   - Do not invent model names or flags. Leave `args` empty unless I give you some.

6. Propose it. Call the operad `command` tool with plugin `bot`, verb `setup-dev`,
   arguments `default` and `<repository directory>`, and the `.operad/dev.json` text as its input. It makes
   a pending item; nothing is turned on or written until I approve it in Pending. If it
   refuses, fix what it names and call it again.

7. Report. Show me the `.operad/dev.json` you proposed, say in one line why you chose each
   check command, worker and reviewer, and say which way of working I chose and what it means for me in a sentence, and list anything you were unsure about. Tell me
   to commit `.operad/dev.json` after I approve it (operad reads it from the main clone).
```

When you are ready, the next steps are `operad serve`, then `operad dev plan add --slug <slug> --title "<title>" < request.md`.
