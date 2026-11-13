---
description: The operad user manual: what operad is and a page for each subject.
---

# operad

operad is an open orchestration layer for coding agents. It runs an agent (radian, Claude Code, pi and others) through verified flows, keeps what happened as history, and reaches a person where the work needs one: the terminal client, the phone app, a notification, a chat. You see three things: flows, things that wait for a person (pending), and what each step did and why (history). Plugins add the rest, such as the `dev` plugin's plans and tasks.

## Pages

- [quickstart](quickstart.md): create the home, start `serve`, open the client.
- [setup-prompt](setup-prompt.md): a prompt that has your agent write `.operad/dev.json`.
- [config](config.md): the home and every section of `config.json`.
- [dev](dev.md): `dev.json` and the `dev` plugin's commands, the reviewer, workers and pools.
- [access](access.md): access profiles, `access-user.json` and always allow.
- [cli](cli.md): every command and option.
- [tui](tui.md): the terminal client, its themes and its keys.
- [app](app.md): pairing and the phone app.
- [http](http.md): the `/v1` endpoints, events and errors.
- [mcp](mcp.md): the MCP server for a lead agent.
- [chats-and-bots](chats-and-bots.md): chats with an agent, and bots.
- [notifications](notifications.md): the notify command.
- [checks](checks.md): checking a change, and reproducing a flaky test.
- [environment](environment.md): every environment variable.
- [troubleshooting](troubleshooting.md): when something does not work.

A complete workflow is in [Running operad on operad](../dogfood.md). Plugin authors start at [Writing a plugin](../plugins/index.md).
