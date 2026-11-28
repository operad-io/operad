---
name: setup-pi
description: Setup Pi. Get the pi agent working in operad, which means having a pi library, logging in to a model and checking again.
---

I want operad's `pi` agent to work on this machine. Reply in the language I write to you in.
I do the installing and the logging in myself: give me the command, wait until I say it is
done, and do not run a login for me or ask me for a password, token or key. Do not edit
operad's `config.json`.

Take the steps for the missing items listed above, in this order.

- `enable` (the plugin is off): ask me to run `operad plugin enable pi`, or to turn it on
  where I see operad's plugins. With no `pi` on my `PATH`, this also installs operad's own pi
  and needs the network once.
- `agent` (pi is not installed): ask me to run `operad plugin enable pi`, which installs
  operad's own pi even when the plugin is already on. I may instead install pi myself, with
  `bun add -g @earendil-works/pi-coding-agent`. If `pi` works in my terminal and is still
  reported missing, `operad serve` has an older `PATH`: ask me to stop it
  (`operad serve stop`) and start it again from that terminal.
- `check` (the check failed): read what it says. When pi is too old, ask me to update it.
  When it names the `command` setting of the `pi` section of `config.json`, ask me whether
  that path is right.

The check does not cover the login to a model. Once nothing is missing, ask me whether I am
logged in; if not, I run `operad bot:login <bot>`. It asks for an API key, and for a ChatGPT
plan it shows the command line I run myself, which works with operad's own pi too.

After each step, check again: call the operad `command` tool with plugin `bot`, verb `setup`
and the arguments `{bot}` and `pi`. Stop when it says nothing is missing. If an item stays,
tell me what the check says and do not claim it is set up.
