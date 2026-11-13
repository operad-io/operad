# Mutation records — `bot`

Rows whose mutation broke code in `packages/bot/` or the `chat` reply it
changes for bots, in the order they were recorded. The root
[MUTATIONS.md](../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0189-M1 | packages/chat/src/reply.ts | the reply used the chat's own copy of the access profile, not the one its profile gives now | `a reply reads the profile again > tightening the access profile applies to the next reply of the same chat` |
| T-0189-M2 | packages/assistant/src/profile.ts | the default access profile did not deny the operad home's contents | `the default access profile > a chat of the default profile cannot read the secrets or the token, and can read its own directory` |
| T-0189-M3 | packages/assistant/src/profile.ts | a working directory that holds the operad home was accepted | `profiles > a working directory that is the operad home, holds it, or is inside it outside assistant is refused` |
| T-0189-M4 | packages/assistant/src/index.ts | a chat was made without naming its profile step | `a reply reads the profile again > a skill added to the profile is given at the next reply; none before` |
| T-0189-M6 | packages/assistant/src/profile.ts | the access profile did not deny the repositories' paths | `repositories > a chat cannot write or read a repository's files, and a repository added later is covered at the next reply` |
| T-0303-M1 | packages/bot/src/bot.ts | the settings reader still read `plugins.assistant` instead of `plugins.bot` | `bots > an \`assistant\` section is no longer read as the bot's settings` |
| T-0326-M1 | packages/bot/src/proposals.ts | a skill proposal wrote its files as it was made, before a person approved it | `a bot proposes a skill > it is one pending item, shows SKILL.md and the files with scripts apart, and applies at the next reply` |
| T-0326-M2 | packages/bot/src/bot.ts | skill directories were no longer denied, so a direct write to a skill was allowed | `a direct write to what the bot changes itself is refused > the skill directories and config.json are outside the bot's write access` |
| T-0326-M3 | packages/bot/src/proposals.ts | a changed skill's review left out the diff | `a bot proposes a skill > a changed skill shows its diff, and reject leaves the old files alone` |
| T-0326-M4 | packages/bot/src/proposals.ts | approving a settings proposal marked it applied but wrote no setting | `a bot proposes settings > the item shows before and after; approve applies them at the next reply; reject leaves them` |
| T-0326-M5 | packages/bot/src/proposals.ts | the apply action was named `confirm` instead of the approved `approve` | `a bot proposes a skill > it is one pending item, shows SKILL.md and the files with scripts apart, and applies at the next reply` |
| T-0332-M1 | packages/bot/src/index.ts | the `harness` argument of `bot:chat` lost its `enum` of the loaded harnesses | `bot:chat > the harness argument is a choice of the loaded harnesses, defaulting to the bot's own, else the first` (and `a harness outside the loaded ones is refused with the list`) |
| T-0330-M1 | packages/bot/src/index.ts | the plugin no longer declared `objectsUnderSettings`, so the bot plugin got a tab of its own again | `bots > the plugin puts its objects under settings, so no client gives it a tab` |
| T-0327-M1 | packages/bot/src/mcp.ts | a changed tool's description is not part of the digest, so a changed description is not detected | `the guard > a changed tool description disables the server, makes a pending item showing the difference and the chat goes on without it` |
| T-0327-M2 | packages/bot/src/mcp.ts | a floating version (a range) is accepted as the pinned version | `registering a local MCP server > a floating version is refused with a message saying to pin it, and the server is never started` |
| T-0327-M3 | packages/bot/src/proposals.ts | approving an MCP server proposal marked it applied but wrote nothing to the settings | `registering a local MCP server > a pasted mcpServers entry works; its env names are the secrets it needs and the values are not kept anywhere` |
| T-0327-M4 | packages/bot/src/index.ts | a chat on pi was given the bot's MCP servers | `a chat mounts only the servers a bot lists > claude and radian chats get the listed servers behind the guard, with no secret in what the harness is given; pi gets none and the bot page says so` |
| T-0327-M5 | packages/bot/src/guard.ts | what a tool returned was passed on without the note that it is material | `the guard > it starts the server with its secrets in the server's environment only, and marks what a tool returns as material` |
| T-0327-M6 | packages/bot/src/guard.ts | the guard did not give the server its secrets at start | `the guard > it starts the server with its secrets in the server's environment only, and marks what a tool returns as material` |
| T-0327-M7 | packages/bot/src/mcp-proposals.ts | a rejected change of tools was proposed again at every start | `the guard > a changed tool description disables the server, makes a pending item showing the difference and the chat goes on without it` |
| T-0327-M8 | packages/bot/src/proposals.ts | a settings proposal could add an MCP server without its review | `registering a local MCP server > a settings change cannot add a server behind the review` |
| T-0327-M9 | packages/bot/src/guard.ts | the guard compared nothing at start: a changed tool list was mounted | `the guard > a changed tool description disables the server, makes a pending item showing the difference and the chat goes on without it` |
| T-0327-M15 | packages/bot/src/mcp-proposals.ts | `bot mcp` did not read a pasted entry piped to it when the caller handed it no input | `registering a local MCP server > a pasted entry piped to the command is read from stdin when the caller hands it no input` |
| T-0327-M16 | packages/bot/src/mcp-proposals.ts | a command the bot's profile asks about was started to read its tools | `registering a local MCP server > a command the bot's profile asks about is not started to read its tools` |
| T-0327-M17 | packages/bot/src/guard.ts | a tool result with structured content and no text block was passed on unmarked | `the guard > it starts the server with its secrets in the server's environment only, and marks what a tool returns as material` |
| T-0327-M18 | packages/bot/src/mcp-client.ts | a server that ignores the stop signal was never killed, so registering it hung | `a server that never answers and ignores the stop signal is given up on after the timeout and killed` (the run never ends; it was stopped after 40 s` |

## T-0338 rework 1 — a bot's configured model

| id | file | mutation | failing test |
|---|---|---|---|
| T-0338-M3 | packages/bot/src/index.ts | a configured bot model the agent does not list was dropped and the default used | `bot:chat and the model > a configured bot model its agent does not list is refused by name, not replaced by the default` |


## T-0342 — a chat's effort

| id | file | mutation | failing test |
|---|---|---|---|
| T-0342-M21 | packages/bot/src/index.ts | `bot:chat` ignored the effort asked for | `bot:chat and the effort > a chat starts with the agent's default effort, the bot's configured one, or the one asked for` |
| T-0342-M22 | packages/bot/src/index.ts | `bot:chat` ignored the bot's configured effort | `bot:chat and the effort > a chat starts with the agent's default effort, the bot's configured one, or the one asked for` |
| T-0342-M23 | packages/bot/src/index.ts | `bot:chat` dropped the effort enum of the loaded agents | `bot:chat and the effort > the effort argument is an enum of the loaded agents' efforts` |

## T-0369 — the new-chat form narrows model and effort by agent

| id | file | mutation | failing test |
|---|---|---|---|
| T-0369-M3 | packages/bot/src/index.ts | `bot:chat` left the `allOf` conditionals out of its schema | `bot:chat per-agent conditionals > one if/then per agent carries its lists and defaults; a bot's model is the default only of the agent that lists it` |
| T-0369-M4 | packages/bot/src/index.ts | the bot's configured model and effort were not passed as the agents' preferred ones | `bot:chat per-agent conditionals > one if/then per agent carries its lists and defaults; a bot's model is the default only of the agent that lists it` |

## T-0410 — plugin versions come from package.json

| id | file | mutation | failing test |
|---|---|---|---|
| T-0410-M1 | packages/bot/src/index.ts | bot required chat `^0.0.0`, which refuses chat 0.0.1 | `plugin versions > every plugin's requirements are met by the versions in this workspace` (packages/cli/test/plugin-versions.test.ts) |

## T-0406 — a channel opens its chat in the same action

| id | file | mutation | failing test |
|---|---|---|---|
| T-0406-M9 | packages/bot/src/index.ts | `bot:chat` dropped the channels it was given instead of passing them to `openChat` | `bot:chat > bot:chat puts the channels it is given on the new chat, and refuses another form` |
