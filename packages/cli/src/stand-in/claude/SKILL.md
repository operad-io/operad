---
name: setup-claude
description: Setup Claude. Get the claude agent working in operad, which means installing Claude Code, logging in and checking again.
---

I want operad's `claude` agent to work on this machine. Reply in the language I write to you
in. I do the installing and the logging in myself: give me the command, wait until I say it
is done, and do not run a login for me or ask me for a password, token or key. Do not edit
operad's `config.json`.

Take the steps for the missing items listed above, in this order.

- `enable` (the plugin is off): ask me to run `operad plugin enable claude`, or to turn it on
  where I see operad's plugins. operad then installs the plugin's package; the first time
  needs the network.
- `agent` (claude is not on PATH): ask me to install Claude Code (https://code.claude.com)
  so that the `claude` command is on my `PATH`. If `claude` works in my terminal and is still
  reported missing, `operad serve` has an older `PATH`: ask me to stop it
  (`operad serve stop`) and start it again from that terminal.
- `check` (the check failed): read what it says. When claude is not logged in, ask me to run
  `claude auth login`. When claude is too old, ask me to run `claude update`. When it names a
  command set in the `claude` section of `config.json`, ask me whether that path is right.

After each step, check again: call the operad `command` tool with plugin `bot`, verb `setup`
and the arguments `{bot}` and `claude`. Stop when it says nothing is missing. If an item
stays, tell me what the check says and do not claim it is set up.
