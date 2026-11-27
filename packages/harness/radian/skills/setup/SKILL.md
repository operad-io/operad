---
name: setup-radian
description: Setup Radian. Get the radian agent working in operad, which means installing radian, logging in and checking again.
---

I want operad's `radian` agent to work on this machine. Reply in the language I write to you
in. I do the installing and the logging in myself: give me the command, wait until I say it
is done, and do not run a login for me or ask me for a password, token or key. Do not edit
operad's `config.json`.

Take the steps for the missing items listed above, in this order.

- `enable` (the plugin is off): ask me to run `operad plugin enable radian`, or to turn it on
  where I see operad's plugins.
- `agent` (radian is not on PATH): ask me to install radian so that the `radian` command is
  on my `PATH`, then to run `radian login`. operad brings no radian of its own. If `radian`
  works in my terminal and is still reported missing, `operad serve` has an older `PATH`: ask
  me to stop it (`operad serve stop`) and start it again from that terminal.
- `check` (the check failed): read what it says. When it names a command that was not found,
  ask me whether the `command` setting of the `radian` section of `config.json` is right.

The check does not cover the login. Once nothing is missing, ask me whether I have run
`radian login`.

After each step, check again: call the operad `command` tool with plugin `bot`, verb `setup`
and the arguments `{bot}` and `radian`. Stop when it says nothing is missing. If an item
stays, tell me what the check says and do not claim it is set up.
