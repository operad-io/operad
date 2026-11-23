---
name: setup-dev
description: Setup Dev. Set up operad's dev for one repository: read its CI and scripts, choose the checks and agents, and propose a .operad/dev.json.
---

Set up operad's dev for the repository at {target}. dev is operad's way of running coding
agents through verified flows (plan, work, verify, review, merge). Your job is to write a
correct `.operad/dev.json` for this repo and propose it. Do not change source code, do not
write the file yourself, do not commit, push or start anything. Reply in the language I write
to you in.

Reference, if you need a key's details: https://operad.io/docs/dev/ (the full key table)
and https://operad.io/llms.txt.

1. Look at the repository. Run `git remote -v` and find the main branch name in {target}.
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
   arguments `{bot}` and `{target}`, and the `.operad/dev.json` text as its input. It makes
   a pending item; nothing is turned on or written until I approve it in Pending. If it
   refuses, fix what it names and call it again.

7. Report. Show me the `.operad/dev.json` you proposed, say in one line why you chose each
   check command, worker and reviewer, and say which way of working I chose and what it means for me in a sentence, and list anything you were unsure about. Tell me
   to commit `.operad/dev.json` after I approve it (operad reads it from the main clone).
