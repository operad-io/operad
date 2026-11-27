---
name: setup-codex
description: Setup Codex. Get the codex agent working in operad, which means installing Codex, logging in and checking again.
---

I want operad's `codex` agent to work on this machine. Reply in the language I write to you
in. I do the installing and the logging in myself: give me the command, wait until I say it
is done, and do not run a login for me or ask me for a password, token or key. Do not edit
operad's `config.json`.

Take the steps for the missing items listed above, in this order.

- `enable` (the plugin is off): ask me to run `operad plugin enable codex`, or to turn it on
  where I see operad's plugins.
- `agent` (codex is not on PATH): ask me to install OpenAI's Codex so that the `codex`
  command is on my `PATH`. operad brings no Codex of its own. If `codex` works in my terminal
  and is still reported missing, `operad serve` has an older `PATH`: ask me to stop it
  (`operad serve stop`) and start it again from that terminal.
- `check` (the check failed): read what it says. When Codex is not logged in, ask me to run
  `codex login`. When Codex is too old or has no app-server, ask me to upgrade it. When it
  names the `command` setting of the `codex` section of `config.json`, ask me whether that
  setting is right.

After each step, check again: call the operad `command` tool with plugin `bot`, verb `setup`
and the arguments `{bot}` and `codex`. Stop when it says nothing is missing. If an item
stays, tell me what the check says and do not claim it is set up.
