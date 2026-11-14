# ADR 0031: MCP Servers on a Bot

Status: accepted

## Background

MCP is a standard protocol, so there is no foreign format to match. Every directory (the official registry, Smithery, the plugin markets of Cursor and Claude) ends in the same two forms: an HTTPS address with a token or OAuth, or a command with arguments. Unlike a skill, an MCP server is resident code or a remote service that can see data, so there are more risks: a swapped package, instructions smuggled into tool descriptions, instructions smuggled into returned content, and a leaked token. Other bots show the lesson: a bot that can add its own MCP servers with almost no gate ends up with fragile connections and a bot that does what it should not.

## Decisions

### D1: No directory; a server is a command or a pasted entry

A server is registered from a command with arguments, or from a pasted `mcpServers` JSON entry (the common form in READMEs and markets). operad talks to no market's interface and does no search or recommendation.

### D2: Registering is a pending item

Registering is a pending item of the bot (ADR 0030 D4). The review page lists the command, the package name and version of a local server, the tools it provides (name and description) and the secrets it needs. Only after a person confirms is it written to the bot's settings.

### D3: A local server is pinned to a version

A floating version (`@latest`, a tag, a range, no version) is refused for a package runner, and the server is not started. An upgrade is its own pending item that shows the change of version and of the tool list. Approving a local server means trusting its package: it is resident and heavier than a skill's script, and the review page says so.

### D4: A change of tools switches the server off

The summary (a digest) of a server's tool names and descriptions is stored. When they differ from what was confirmed, that server is switched off and a pending item shows the difference; a person reviews it before it is switched on again. This guards against a server that passes review and then changes its tool descriptions to smuggle in instructions.

### D5: What an MCP server returns is material

Content an MCP server returns is material, not instructions (ADR 0009). Calls to its tools follow the access profile (ADR 0025): a tool not listed as allowed counts as a write and asks first.

### D6: Secrets reach the server only at its start

Only the names of the environment variables a server needs are kept; a value is used once to start the server and read its tool list, then dropped. Each value is stored as a plugin secret and reaches the server only at its start, in the server's environment: not in the transcript, not in the agent's environment, not in the settings the harness is given.
