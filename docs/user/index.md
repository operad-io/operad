---
description: The operad user manual: what operad is and a page for each subject.
---

# operad

operad is an open orchestration layer for coding agents. It runs an agent (radian, Claude Code, pi and others) through verified flows, keeps what happened as history, and reaches a person where the work needs one: the terminal client, the phone app, a notification, a chat. You see three things: flows, things that wait for a person (pending), and what each step did and why (history). Plugins add the rest, such as the `dev` plugin's plans and tasks.

Orchestrating agents here means composing the flow a task follows, not handing out roles. A flow fixes the steps a task goes through and the checks between them; which agent does a step is a setting you can change.

## Pages

- [quickstart](quickstart.md): create the home, start `serve`, open the client.
- [setup-prompt](setup-prompt.md): Setup Dev, which has your bot propose `.operad/dev.json` and turn `dev` on.
- [config](config.md): the home and every section of `config.json`.
- [dev](dev.md): `dev.json` and the `dev` plugin's commands, the reviewer, workers and pools.
- [home-flows](home-flows.md): your own flows as files in the home.
- [access](access.md): access profiles, `access-user.json` and always allow.
- [cli](cli.md): every command and option.
- [tui](tui.md): the terminal client, its themes and its keys.
- [app](app.md): pairing and the phone app.
- [http](http.md): the `/v1` endpoints, events and errors.
- [tailscale](tailscale.md): reaching `serve` over a Tailscale network, and the HTTPS name the phone app needs.
- [mcp](mcp.md): the MCP server for a lead agent.
- [chats-and-bots](chats-and-bots.md): chats with an agent, and bots.
- [memory](memory.md): a bot's memory, the shared wiki and the git history of what a bot wrote.
- [telegram](telegram.md): write to a bot and answer what waits for you from Telegram.
- [notifications](notifications.md): the notify command.
- [checks](checks.md): checking a change, and reproducing a flaky test.
- [environment](environment.md): every environment variable.
- [troubleshooting](troubleshooting.md): when something does not work.

Plugin authors start at [Writing a plugin](../plugins/index.md).
