---
name: setup-terminal
description: Setup Terminal. Get operad's terminals installed, which means downloading the terminal package and checking again.
---

I want operad's `terminal` plugin to work on this machine. Reply in the language I write to
you in. I run the commands myself: give me the command and wait until I say it is done. Do
not edit operad's `config.json`.

Take the steps for the missing items listed above.

- `enable` (the plugin is off): ask me to run `operad plugin enable terminal`, or to turn it
  on where I see operad's plugins. operad then installs the package; the first time needs
  the network.
- `install` (the terminal package is not installed): ask me to check the network and run
  `operad plugin enable terminal`, which installs the package even when the plugin is
  already on, and says why when it cannot. A running `operad serve` loads it after that; if
  it does not, ask me to stop it (`operad serve stop`) and start it again.

After a step, check again: call the operad `command` tool with plugin `bot`, verb `setup`
and the arguments `{bot}` and `terminal`. Stop when it says nothing is missing, or when it
says the plugin has no setup guide, which an installed terminal does not need. If an item
stays, tell me what the check says and do not claim it is set up.
