---
description: When something does not work: each message operad prints that you can act on, and what to do.
---

# Troubleshooting

This page lists the messages `operad` prints that need you to do something, by
where they come from. Run `operad help` for the command table, `operad pending`
for what waits, and `operad history <id>` for what a run did.

## The command line

| Message | What it means | What to do |
|---|---|---|
| `operad: unknown command "<command>"` | No command or plugin verb has that name. | `operad help` lists the commands; a plugin verb is `<plugin> <verb>` or the short form when only one plugin declares it. |
| `operad: <option> needs a value` | A flag that takes a value is last on the line. | Put the value after it, or use `--flag=value`. |
| `operad: action "<name>" needs a note; pass --note <text>` | The action needs a note and stdin is not a terminal. | Pass `--note <text>`; in a terminal it asks for one. |
| `operad: action "<name>" needs confirmation; pass --yes` | The action asks to confirm and stdin is not a terminal. | Pass `--yes` after reading what the action does. |
| `operad: action "<name>" has no argument "--<flag>"` | The action's schema does not declare that argument. | `operad show <id>` lists the actions with their arguments; a note may have another flag name. |
| `operad: "<id>" is ambiguous: use task:<id>, …` | A bare id is owned by several object types. | Prefix it with the type the message lists. |
| `operad: no run or object "<id>"` | No run, object or event has that id. | `operad list <type>` or `operad show` (with no id) shows the recent objects. |
| `operad: no run "<id>"` | `run-internal` named a run that does not exist. | This command is internal; start work through `serve` and `pending`. |
| `operad: run "<id>": flow "<flow>" is not loaded` | The run uses a flow whose plugin is disabled or missing. | `operad plugin list`, enable the plugin, then `operad serve`. |
| `operad: plugin "<name>" is disabled` | The command or action belongs to a disabled plugin. | `operad plugin enable <name>`. |
| `operad: plugins.<name>: no such plugin` | `plugin enable` or `disable` named nothing the config knows. | Use a configured name, or a shipped optional plugin (`pi`, `claude`, `pool`, `bot`). |
| `operad: cannot disable "<name>": run "<id>" (<step>) is active` | A run is using one of the plugin's steps. | Let that run finish, or cancel it, then disable the plugin. |
| `operad: lock <path>: run <pid> is still alive` (exit 4) | Another process holds the home or a run lock. | Wait for it, or stop the `serve` that owns it with `operad serve stop`. |
| `operad: secret set: no value was read` | The terminal or stdin gave no value. | Run it again and type the value, or pipe one line. |
| `operad: settings set needs a name and a value` | The setting name or value is missing. | `operad settings` lists names; pass a value, as JSON or a plain string. |
| `operad: <setting> …; pass --yes to change it` | The setting changes what merges or another guarded choice. | Read the change, then repeat with `--yes`. |
| `operad: no editor is set; set $EDITOR` | `task edit` needs a brief and no editor is configured. | Set `EDITOR`, or pipe the brief on stdin. |
| `operad: task edit waited 1s for the brief on standard input; nothing arrived, and no editor is set; pipe the brief or set $EDITOR` | stdin was a pipe nobody wrote to, and no editor is set. | Pipe the brief, or set `EDITOR`/`VISUAL`. |
| `operad: "<editor>" exited with code <n>` | The editor failed. | Fix the editor command or the file, then retry. |
| `operad: task is <phase>; only proposed or ready tasks can change` | The task has started or ended. | Change it only before the first attempt; use a follow-up task after that. |

## serve and config.json

| Message | What it means | What to do |
|---|---|---|
| `operad: lock <home>/serve.lock: run <pid> is still alive` (exit 4) | A `serve` already runs for this home. | Use the running one, or `operad serve stop`. |
| `Failed to start server. Is port <port> in use?` | The configured address and port are taken. | Free the port, or change `http.port`/`http.listen`; `operad tui --url <url>` can reach another one. |
| `http.listen: "<address>" is a wildcard address; name each address to listen on` | `http.listen` names `0.0.0.0` or `::`. | Name each address explicitly (loopback, private, link-local or Tailscale). |
| `http.listen: "<address>" is not a loopback, private, link-local or Tailscale address` | The address is public or not an IP literal. | Use an allowed address, or reach the home through Tailscale. |
| `http.listen: needs at least one address` | The array is empty. | Leave the key out for `["127.0.0.1"]`, or name an address. |
| `http: <address> did not release the port` | A stop or reload could not release an address in time. | Stop the process that holds it, then `operad serve`. |
| `code changed (<what>) but does not load; the old code keeps running: <problems>` | New code or a settings file has an error. | Fix the file; the old code keeps serving and reloads when the files load. |
| `reload: the new code could not listen (<reason>); the old code tries every address again` | A reload lost its port to another process. | Free the port; the old code keeps serving meanwhile. |
| `operad: <file>: invalid JSON: <reason>` | `config.json`, `triggers.json`, `keys.json` or `tui.json` does not parse. | Fix the JSON; the message names the file and the parser's reason. |
| `operad: <file>: must be a JSON object` | A settings file holds an array or a scalar. | Make its top level an object. |
| `operad: <file>: plugins.<name>: no such plugin` | A plugin entry names nothing shipped and no module was given. | Use the shipped name, or write `"module": "<package or path>"`. |
| `operad: <file>: store.backend: must be "sqlite"` | sqlite is the only storage supported. | Set `store.backend` to `"sqlite"`, or leave it out. |
| `operad: <file>: notify.on: must be an array of "waiting"` | `notify.on` names another value. | Use `["waiting"]`; see [Notifications](notifications.md). |
| `operad: <file>: mcp.channel.notify: <value> is not a channel notification` | The channel list names another value. | Use `waiting`, `ended`, `loop` or `changes`. |
| `operad: <file>: mcp.channel.loopAfter: must be an integer of 2 or more` | The loop threshold is too small or not a whole number. | Set `loopAfter` to 2 or more. |
| `operad: <file>: ask.graceSecs: must be a whole number of 0 to <max>` | The ask grace is outside its range. | Use a whole number in the range the message gives. |

## The terminal client

| Message | What it means | What to do |
|---|---|---|
| `no server at <url>: is `operad serve` running? retrying  q quit` | Nothing answers at the address, or the address is wrong. | Start `operad serve`, or pass `--url`; check `http.enabled`, `http.port` and `http.listen`. |
| `the token was rotated: run the TUI again or pass --token  q quit` | The server replaced its token. | Run `operad tui` again (it reads the new token), or pass `--token`. |
| `tui needs a terminal` | Output is not a terminal. | Run it in a terminal, not through a pipe. |
| `theme not changed: <why>` | A watched `tui.json` or theme file is invalid. | Fix the file; the last good theme stays. |
| `unknown theme "<name>"; the themes are <names> in <file>` | `tui.json` names no known theme. | Pick a name from the list, or create `themes/<name>.json`. |
| `unknown theme "<name>"; the themes are <names> given with --theme` | `--theme` names no known theme. | Pick a name from the list, or drop the flag. |
| `reserved keys ignored: <key> (<action>, <source>), …` | `keys.json` or a plugin binds a key the TUI keeps. | Use another key; the action remains in the `:` palette. |
| `starting operad serve (log: <path>)` then an error naming `serve.log` | The TUI tried to start `serve` and it failed. | Read the last lines of `serve.log` (it can hold plugin output); fix the problem, then start again. |
| `no server at <url> …` when no `serve` holds the home and `--no-start` was given | `--no-start` prevents a start. | Start `operad serve` yourself, or drop `--no-start`. |

## The app and HTTP

| Message | What it means | What to do |
|---|---|---|
| `a bearer token is required` (`401`) | The request has no token or an old one. | Pair again or rotate: `operad pair --show-token`, then update the app. |
| `the token was rotated: run the TUI again or pass --token` | Same, in the terminal client. | Run the client again, or pass the new token. |
| `pair prints the token and needs a terminal; pass --show-token to print it anyway` | `pair` refuses to write the token to a pipe. | Run it in a terminal, or pass `--show-token` only where that is safe. |
| `pair needs "http.enabled" in config.json` | HTTP is off. | Set `http.enabled` to `true` and restart `serve`. |
| `http.listen has only loopback addresses, which a phone cannot reach; add one or pass --url` | The app cannot reach a loopback address. | Add a private or Tailscale address to `http.listen`, or pass `--url`. |
| `http.port is 0; set a port in config.json or pass --url` | The chosen port is dynamic. | Set a fixed `http.port`, or pass `--url`. |
| `--url must be an http or https URL` | The scheme is missing or wrong. | Use `http://…` or `https://…`. |
| `--url must be an http or https URL without credentials or a query` | The URL carries a user, password, query or fragment. | Pass only the base URL. |
| `the file is larger than the 20 MB limit` (`413`) | An upload is too large. | Send a smaller file, or split it. |
| `the request body is larger than the 1 MB limit` (`413`) | A JSON request is too large. | Send less data in one action. |
| `no such endpoint` (`404`) | The path is not a `/v1` endpoint. | Check the path on [the HTTP page](http.md#endpoints). |
| `this endpoint takes GET` or `this endpoint takes POST` (`405`) | The method is wrong. | Use the method the endpoint names. |
| `the action is not available now` (`409`) | The object's state does not offer it. | Refresh the object; `operad show <id>` lists what it offers now. |
| `the action needs confirmation` (`409`) | The action asks to confirm and the request did not. | Send `"confirmed": true` after reading it. |
| `the action's plugin is not loaded` (`409`) | The plugin was disabled or did not load. | `operad plugin enable <name>`, then restart `serve`. |
| `the request failed` (`500`) | An unexpected error happened; the body has no stack trace. | `operad serve` prints the reason on its output; `operad history` shows the run. |
| A section did not load in time (`504`) | A section took too long. | Retry; `--full` does not change the timeout. |

## MCP

| Message | What it means | What to do |
|---|---|---|
| `action "<name>" is not allowed through MCP; the owner runs it` | The action is not in `mcp.actions`, or asks to confirm and is not in `mcp.confirmActions`. | Run it yourself, or add it to both lists in `config.json` and restart `operad mcp`. |
| `there is no action "<name>"` | No loaded plugin declares it. | `operad show <id>` lists the actions; enable the plugin if it is disabled. |
| `list needs a type, root or parent` | The `list` tool got no name of what to list. | Pass `type`, `root` or `parent`. |
| `"<plugin>" is a kernel verb; it is not reachable through MCP` | The `command` tool named a kernel command as a plugin. | Use a plugin verb (`dev`, `chat`, `bot`) or run the command yourself. |
| `"<verb>" is a kernel verb; it is not reachable through MCP` | The verb belongs to the kernel. | Use a plugin verb, or run the kernel command yourself. |
| `no loaded plugin "<plugin>" declares the verb "<verb>"` | The pair is wrong. | `operad flows` and `operad plugin list` show what is loaded. |
| `action "<name>" takes a file (<names>); a file is sent by a client that uploads it, not through these tools` | A file argument cannot be an MCP path. | Send the file from the app or another client with `POST /v1/uploads`. |
| A JSON-RPC error `-32602` | The tool call is malformed. | Check the tool's input schema on [the MCP page](mcp.md#tools). |

## Checks and tests

| Message | What it means | What to do |
|---|---|---|
| `run-tests: OPERAD_TEST_PARALLEL must be a whole number of 1 or more, not '<value>'` | The variable is wrong. | Set a whole number of 1 or more, or unset it. |
| `remote-check: no clone at ~/<tree>` | The check host has no clone at `OPERAD_CHECK_TREE`. | Clone the repository there, or set `OPERAD_CHECK_TREE`. |
| `remote-check: fetch of the bundle failed` | The host could not read the copied bundle. | Check the ssh destination and the host's disk; retry. |
| A check that fails before its line runs exits 1 | The bundle, copy, connection, fetch or checkout failed. | The one line names the step; fix the host or the network, then retry. |
| A stress run fails | A test failed under repetition or load. | The log names each failing test; fix the test or the code, then rerun. Do not raise a timeout or add a retry inside the test. |

## dev and bot

| Message | What it means | What to do |
|---|---|---|
| `no repository "<name>"` | The repository is not registered. | `operad dev repo add <path> [--name <name>]`. |
| `repository "<name>" was removed` | The repository was removed. | Add it again under its path. |
| `<path> has no remote` | `repo add` needs a remote. | Add an `origin` remote, then retry. |
| `no plan "<plan>"` | The plan id is wrong or not in this repository. | `operad list plan --repo <name>`. |
| `no task "<task>"` | The task id is wrong. | `operad list task --repo <name>`. |
| `a task cannot follow itself` | `--after` names the task itself. | Remove that `--after`. |
| `cycle: <a> -> <b> -> <a>` | The `--after` chain is circular. | Remove one edge. |
| `--flow: no flow "<name>" in repository "<name>"` | The flow is not defined in `.operad/dev.json`. | Use a defined flow, or add it. |
| `plan "<plan>" is not in repository "<name>"` | The plan belongs to another repository. | Use `--repo` for the plan's repository. |
| `task is <phase>; only proposed or ready tasks can change` | The task has started. | Change it before the first attempt. |
| `there is no bot "<name>"` | The bot is not in `plugins.bot.settings.bots`. | Add it, then retry. |
| `bot "<name>": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit` | The bot name is not allowed. | Rename it. |
| `agent "<name>" is not loaded; the loaded ones are: …` | The bot's agent or `--agent` is not loaded. | `operad plugin enable <name>` (one of `claude`, `pi`, `radian`). |
| `MCP server "<name>": a name is lowercase letters, digits and "-", with single "_" between parts` | The server name is not allowed. | Rename it; `operad` is reserved for operad's own server. |
| `"<spec>" is not pinned (<why>). Pin an exact version …` | A package command names a tag or range. | Write an exact version, as `name@1.2.3`. |
| `a remote server (an address) cannot be registered yet; only a local one, a command with arguments` | The pasted entry is a URL. | Use a local command. |
| `the pasted server needs a command` | The input has no `command`. | Paste a complete `mcpServers` entry. |
| `could not read the tools of "<name>" by starting it: <reason>` | The server did not start or answer. | Fix its command or install it; store its secrets with `operad secret set bot <server>.<variable>` before retrying. |
| `a skill needs a SKILL.md` | The proposed skill has no `SKILL.md`. | Add one, or point `--from` at a directory that has it. |
| `MCP servers are registered with `operad bot mcp`…` | `bot setting` tried to edit `mcpServers`. | Use `operad bot mcp`. |
| `the user access file "<path>" <problem>; it is treated as empty` | `access-user.json` is invalid. | Fix or delete the file; no always-allowed entry is used until it reads. |
