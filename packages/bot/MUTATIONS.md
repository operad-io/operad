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

## T-0411 — bot's chat requirement has an upper bound

| id | file | mutation | failing test |
|---|---|---|---|
| T-0411-M1 | packages/bot/src/index.ts | bot required chat `>=0.0.1`, which also accepts a future chat 0.1.0 | `plugin versions > no requirement accepts a future incompatible version of the plugin it names` (packages/cli/test/plugin-versions.test.ts) |

## T-0475 — every setting needs a title

| id | file | mutation | failing test |
|---|---|---|---|
| T-0475-M4 | packages/bot/src/bot.ts | the `bots` setting lost its title, so a schema row a client shows had none | `plugin versions > every setting a client shows has a short title` (packages/cli/test/plugin-versions.test.ts) |

## T-0499 — bot skills are readable, and a listed directory loads its skills

| id | file | mutation | failing test |
|---|---|---|---|
| T-0499-M1 | packages/bot/src/bot.ts | a skill directory was denied for reading too: its paths were not added to `readPaths` | `skills > a skill is readable but cannot be written, edited or removed` |
| T-0499-M2 | packages/bot/src/bot.ts | a skill directory was no longer denied for writing, so a write asked instead of being refused | `skills > a skill is readable but cannot be written, edited or removed` |
| T-0499-M3 | packages/bot/src/bot.ts | a listed parent directory no longer loaded the skills directly inside it | `skills > a listed parent directory loads every skill directly inside it, including one added later` |
| T-0499-M4 | packages/bot/src/bot.ts | a listed `.agents` directory no longer read its `skills` directory | `skills > a listed .agents directory loads the skills directly inside its skills directory, including one added later` |
| T-0499-M5 | packages/bot/src/index.ts | a bot's page showed skill paths instead of skill names | `bots > a bot's page shows each skill's name, not only its path` |
| T-0499-M6 | packages/bot/src/proposals.ts | approving a skill no longer added it to the bot's skills | `a bot proposes a skill > it is one pending item, shows SKILL.md and the files with scripts apart, and applies at the next reply` |
| T-0499-M7 | packages/bot/src/proposals.ts | a change targeted a new skill under `<cwd>/skills` instead of the skill already mounted through a listed parent | `a bot changes a skill loaded from a listed directory > the skill it already mounts under that name is the one the proposal targets` |

## T-0501 — a bot created with only the skills and MCP servers chosen

| id | file | mutation | failing test |
|---|---|---|---|
| T-0501-M1 | packages/bot/src/create.ts | `~/.agents/skills` was no longer offered among the known skills | `bot:create offers what the home already knows > the skill and server choices are the ones the bots and the standard directory know` |
| T-0501-M2 | packages/bot/src/create.ts | the chosen skills were written as an empty list | `creating a bot with chosen skills and MCP servers > two of three known skills and one of two approved servers are exactly what it gets` |
| T-0501-M3 | packages/bot/src/create.ts | a copied MCP server lost its pinned version and digest | `creating a bot with chosen skills and MCP servers > a copied server keeps its pin, tools and digest, and starts without a new approval` |
| T-0501-M4 | packages/bot/src/create.ts | a server that was never approved was copied from the first known one instead of being refused | `refusals while creating a bot > a server that was never approved is refused and nothing is written` |
| T-0501-M5 | packages/bot/src/create.ts | a bot with no chosen skills inherited `default`'s | `creating a bot with chosen skills and MCP servers > nothing chosen means no skills and no servers, and nothing comes from default` |
| T-0501-M6 | packages/bot/src/create.ts | the copied servers' secret names were no longer reported in the result | `creating a bot with chosen skills and MCP servers > the result names the secrets the copied servers need` |
| T-0501-M8 | packages/bot/src/create.ts | the bot-name validation and the existing-name check were removed, so a bad or duplicate name was written | `refusals while creating a bot > a duplicate or bad name is refused and the existing bot is unchanged` |
| T-0501-M9 | packages/bot/src/create.ts | a skill path with no SKILL.md was accepted, because the path check and the resolution check were removed | `refusals while creating a bot > a skill path without a SKILL.md is refused` |
| T-0501-M10 | packages/bot/src/index.ts | `bot:create` no longer checked the model and effort against the chosen agent's lists | `refusals while creating a bot > a model or effort the chosen agent does not list is refused by name` |
| T-0501-M11 | packages/bot/src/index.ts | a bot page no longer showed its skills and MCP servers | `creating a bot with chosen skills and MCP servers > two of three known skills and one of two approved servers are exactly what it gets` |
| T-0501-M12 | packages/bot/src/create.ts | a skill given as a path was ignored instead of read from that directory | `creating a bot with chosen skills and MCP servers > a path may be given instead of a known skill, and the path stays the setting` |

## T-0505 — skills follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0505-M1 | packages/bot/src/proposals.ts | a missing or empty listed skill path stopped a proposal instead of being skipped | `a bot changes a skill loaded from a listed directory > a listed path that is missing or empty is skipped, and the mounted skill is still found` |
| T-0505-M4 | packages/bot/src/create.ts | creating a bot read the bot map before the lock, so two creates at once dropped one | `creating a bot with chosen skills and MCP servers > two creates at once keep both new bots` |

## T-0517 — a bot uses the owner's own agent settings

| id | file | mutation | failing test |
|---|---|---|---|
| T-0517-M5 | packages/bot/src/bot.ts | resolving a bot always said the own-settings switch was off | `bots > using the owner's own agent settings is off unless the bot turns it on` |
| T-0517-M6 | packages/bot/src/index.ts | `bot/settings` did not return the own-settings switch | `a reply reads the bot again > the own-settings switch is off by default and reaches the agent when on` |

## T-0525 — chat access levels

| id | file | mutation | failing test |
|---|---|---|---|
| T-0525-M13 | packages/bot/src/index.ts | a new bot chat started at `plan` instead of `ask` | `bot:chat > opens a chat of the chat plugin with the bot as its parent` |

## T-0530 — a harness describes each model it lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0530-M7 | packages/bot/src/index.ts | `bot:chat` and `bot:create` left out the descriptions of the models they offer | `bot:chat and the model > bot:chat and bot:create carry what each agent knows about each model` |

## T-0532 — the built-in default access profile

| id | file | mutation | failing test |
|---|---|---|---|
| T-0532-M3 | packages/bot/src/bot.ts | the bot's default no longer added `operad` to `denyCommands` | `a reply reads the bot again > the agent gets operad's tools and works in the bot's directory, not a repository` |

## T-0546 — scheduled prompts of a bot

| id | file | mutation | failing test |
|---|---|---|---|
| T-0546-M1 | packages/bot/src/schedule.ts | a normal poll never chose a due minute | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |
| T-0546-M2 | packages/bot/src/schedule.ts | the source ignored `paused`, so a paused entry fired | `scheduled prompts > a paused entry does not fire` |
| T-0546-M3 | packages/bot/src/schedule.ts | `schedule-edit` kept the old schedule instead of the one given | `scheduled prompts > edit changes the next run` |
| T-0546-M4 | packages/bot/src/schedule.ts | `schedule-remove` wrote the entry back, so it still fired | `scheduled prompts > remove stops it` |
| T-0546-M5 | packages/bot/src/schedule.ts | a catch-up firing sent the bare prompt without its planned time and lateness line | `scheduled prompts > a catch-up firing adds the planned time and how late it is to the prompt` |
| T-0546-M6 | packages/bot/src/schedule.ts | the notification carried an empty summary instead of the reply's | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |
| T-0546-M7 | packages/bot/src/index.ts | syncing a bot from the settings dropped the scheduled entries stored on its object | `scheduled prompts > the view shows next run time and the last result and chat id; edit, pause, resume and remove are actions` |
| T-0546-M8 | packages/bot/src/index.ts | the scheduled message was sent with the bot's actor but no `bot` event source, so it came from `other` and counted as a person's | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |
| T-0546-M9 | packages/bot/src/schedule.ts | the bot page left out the last run's result and chat id | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |

## T-0547 — a schedule a bot writes in a chat is a proposal

| id | file | mutation | failing test |
|---|---|---|---|
| T-0547-M1 | packages/bot/src/proposals.ts | a schedule proposal applied its add, edit or remove as it was made | `schedules a chat proposes > a chat's add makes a pending proposal and no entry; approve adds it, reject leaves none` (and the edit and remove tests) |
| T-0547-M2 | packages/bot/src/proposals.ts | approving a schedule proposal marked it applied but changed no entry | `schedules a chat proposes > a chat's add makes a pending proposal and no entry; approve adds it, reject leaves none` (and the edit and remove tests) |
| T-0547-M3 | packages/bot/src/schedule.ts | applying a proposed edit wrote the entry before instead of after | `schedules a chat proposes > a proposed edit leaves the entry as it is until approve` |
| T-0547-M4 | packages/bot/src/proposals.ts | the review dropped the schedule in words | `schedules a chat proposes > a chat's add makes a pending proposal and no entry; approve adds it, reject leaves none` (and the edit test) |
| T-0547-M5 | packages/bot/src/index.ts | `bot/settings` returned no starting line, so the bot's agent was not told a schedule is a proposal | `schedules a chat proposes > a bot chat starts with the line that a schedule is a proposal` |
| T-0547-M6 | packages/bot/src/schedule.ts | applying a proposed remove left the entry in place | `schedules a chat proposes > a proposed remove deletes the entry only after approve` |
| T-0547-M7 | packages/bot/src/proposals.ts | the duplicate-add refusal was skipped, so a second schedule with the same name was proposed | `schedules a chat refuses to propose > an add of a name the bot already has is refused` |
| T-0547-M8 | packages/bot/src/proposals.ts | an edit of a missing name was not refused, while a remove still was | `schedules a chat refuses to propose > an edit of a missing name is refused` |
| T-0547-M9 | packages/bot/src/proposals.ts | a remove of a missing name was not refused, while an edit still was | `schedules a chat refuses to propose > a remove of a missing name is refused` |
| T-0547-M10 | packages/bot/src/proposals.ts | an add without the schedule in words was accepted | `schedules a chat refuses to propose > an add without the schedule in words is refused` |
| T-0547-M11 | packages/bot/src/proposals.ts | an add accepted the schedule without checking the cron expression | `schedules a chat refuses to propose > a malformed cron expression is refused` |
| T-0547-M12 | packages/bot/src/proposals.ts | an edit with nothing to change was accepted | `schedules a chat refuses to propose > an edit with nothing to change is refused` |
| T-0547-M13 | packages/bot/src/proposals.ts | a remove carrying other fields was accepted | `schedules a chat refuses to propose > a remove that carries other fields is refused` |

## T-0551 — scheduled tasks follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0551-M1 | packages/bot/src/schedule.ts | approving an edit wrote the proposal's snapshot over the entry instead of applying only what it changed | `schedules a chat proposes > approving an edit keeps a pause made after the proposal and applies only what it changed` |
| T-0551-M2 | packages/bot/src/schedule.ts | the result and notification were taken at the first assistant message of a reply that goes round again | `scheduled prompts > a reply that goes round again is notified when it ends, not at its first message` |
| T-0551-M3 | packages/bot/src/schedule.ts | the watch matched the entry by planned time as well as chat id, so a re-baselined entry lost its result | `scheduled prompts > editing the schedule of a firing that awaits its reply still records its result` |
| T-0551-M4 | packages/bot/src/schedule.ts | editing the schedule cleared `last`, dropping the chat of a firing awaiting its reply | `scheduled prompts > editing the schedule of a firing that awaits its reply still records its result` |

## T-0553 — scheduled gaps from the desktop and iOS reviews

| id | file | mutation | failing test |
|---|---|---|---|
| T-0553-M1 | packages/bot/src/schedule.ts | `schedule-edit` kept the old model and effort when given an empty value | `scheduled prompts > an edit with an empty model or effort clears it` |
| T-0553-M2 | packages/bot/src/proposals.ts | a proposed edit kept the old model and effort when given an empty value | `schedules a chat proposes > a proposed edit with an empty model or effort clears it on approve` |
| T-0553-M3 | packages/bot/src/index.ts | a bot row carried no structured scheduled prompts | `scheduled prompts > a bot row carries its scheduled prompts as structured data` |
| T-0553-M4 | packages/bot/src/schedule.ts | a firing named itself `scheduled` instead of the entry in its actor, so the chat recorded the wrong entry | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |
| T-0553-M5 | packages/bot/src/schedule.ts | the structured entry left out the last result | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |
| T-0553-M6 | packages/bot/src/index.ts | `bot:chat` recorded no scheduled origin on a chat the source opened | `scheduled prompts > an entry fires on time, opens a new chat under the bot with its prompt, and the reply's notification carries a summary` |

## T-0554 — scheduled gaps follow-ups

| id | file | mutation | failing test |
|---|---|---|---|
| T-0554-M1 | packages/bot/src/schedule.ts | `mergedEdit` treated an empty model or effort as unchanged, so approving a proposed edit kept the old one (T-0553-M2 named `proposals.ts`; this is where the approve-time clear is) | `schedules a chat proposes > a proposed edit with an empty model or effort clears it on approve` |

## T-0559 — a proposal's actions put approve first

| id | file | mutation | failing test |
|---|---|---|---|
| T-0559-M1 | packages/bot/src/proposals.ts | the actions kept `review` first, so a client's main button showed the review instead of approving | `a bot proposes a skill > it is one pending item, shows SKILL.md and the files with scripts apart, and applies at the next reply` |

## T-0584 — the default bot's own directory, memory and sessions

| id | file | mutation | failing test |
|---|---|---|---|
| T-0584-M1 | packages/bot/src/bot.ts | the default bot kept the old `~/.operad/bot` directory | `bots > the default bot exists without being written, with its own directory` |
| T-0584-M2 | packages/bot/src/bot.ts | the move no longer kept another bot's directory out of the default bot's home | `the default bot's directory > the old home moves into default, while another bot's directory stays put` |
| T-0584-M3 | packages/bot/src/bot.ts | resolving a bot no longer made its `memory/` directory | `memory and the other bots' directories > every bot gets memory, which it may write, while another bot's directory is denied` |
| T-0584-M4 | packages/bot/src/bot.ts | another bot's directory was no longer added to the access profile | `memory and the other bots' directories > every bot gets memory, which it may write, while another bot's directory is denied` |
| T-0584-M5 | packages/bot/src/bot.ts | the default move left claude's old project directory in place | `harness sessions after the move > claude's project directory moves to the directory named for the new working directory` |
| T-0584-M6 | packages/bot/src/bot.ts | the default move left radian's journal naming the old workspace | `harness sessions after the move > radian's journal records the new workspace and other journals are untouched` |
| T-0584-M7 | packages/bot/src/bot.ts | the move deleted `default/` before each entry, so an entry moved before a crash was lost | `the default bot's directory > a crash in a child halfway through the move loses nothing, and the next run finishes it` |

## T-0584 rework 1 — bot directories and a finished move

| id | file | mutation | failing test |
|---|---|---|---|
| T-0584-M8 | packages/bot/src/bot.ts | only a bot's name was protected, not the working directory a setting or a removed bot names | `the default bot's directory > a bot directory under another name, and a removed bot's directory, are not swept into default` |
| T-0584-M9 | packages/bot/src/bot.ts | the marker of a finished move was ignored, so a later read moved a new entry and read the journals again | `the default bot's directory > once the move is done, a later read moves no new entry and reads no journal` |

## T-0584 rework 2 — only operad's entries move

| id | file | mutation | failing test |
|---|---|---|---|
| T-0584-M10 | packages/bot/src/bot.ts | every top-level entry in the old home was moved instead of only operad's `skills/` and `memory/` | `the default bot's directory > only skills and memory move; an unknown file and directory stay and the default bot can use them` |
| T-0584-M11 | packages/bot/src/bot.ts | the default bot denied every old-home directory again instead of only another bot's | `the default bot's directory > only skills and memory move; an unknown file and directory stay and the default bot can use them` |
| T-0584-M12 | packages/bot/src/bot.ts | claude's project directory moved while a claude kept worker was alive | `harness sessions after the move > claude's old project directory waits while a claude worker is alive, then moves on the next read` |

## T-0584 rework 3 — grants that named the old home

| id | file | mutation | failing test |
|---|---|---|---|
| T-0584-M13 | packages/bot/src/bot.ts | a grant whose `cwd` was the old default home was left in place | `grants after the move > a grant made in the old home keeps matching, while every other grant stays byte for byte` |

## T-0585 — the wiki, a bot's write setting and the memory skill

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M7 | packages/bot/src/bot.ts | `accessFor` reversed the default write rule, so the default bot only read the wiki | `who may write the wiki > the default bot writes it and every other bot only reads it` |
| T-0585-M8 | packages/bot/src/bot.ts | `resolveBot` did not add the memory skill to a bot | `the memory skill and the commit step > every bot mounts the memory skill while the plugin is enabled` |

## T-0585 rework 1 — the after field, writeWiki and the memory layout

| id | file | mutation | failing test |
|---|---|---|---|
| T-0585-M11 | packages/bot/src/index.ts | `runSettings` named the commit step even when `memory/commit` was not loaded | `the memory skill and the commit step > the bot's settings name the commit step only when the memory plugin is loaded` |
| T-0585-M12 | packages/bot/src/bot.ts | `accessFor` ignored the bot's `writeWiki` setting and used the default bot rule for every bot | `who may write the wiki > a bot's writeWiki setting decides for that bot` |
| T-0585-M14 | packages/bot/src/bot.ts | `ensureBotMemory` no longer made the memory layout when the plugin was enabled | `the memory skill and the commit step > a bot's memory gets the three-layer layout when the plugin is enabled` |

## T-0586 — the bot's notes on a chat message

| id | file | mutation | failing test |
|---|---|---|---|
| T-0586-M9 | packages/bot/src/index.ts | `bot/settings` stopped returning the memory notes | `the memory notes a bot chat carries > its index and instructions go on the message, never into the chat's own text` |

## T-0588 — the nightly memory tidy

| id | file | mutation | failing test |
|---|---|---|---|
| T-0588-M4 | packages/bot/src/tidy.ts | the source returned before the planned check time, so a night never ran | `the nightly memory check > a night with work sends one card, and the next check updates the same card's counts` |
| T-0588-M5 | packages/bot/src/tidy.ts | a pending card was stored under a new id for each night | `the nightly memory check > a night with work sends one card, and the next check updates the same card's counts` |
| T-0588-M6 | packages/bot/src/tidy.ts | `skip` returned without changing the card's state | `Run and Skip > Run starts the tidy after no chat is replying, and Skip closes the result until the next check` |
| T-0588-M7 | packages/bot/src/tidy.ts | the source ignored `runWithoutAsking` and always made a card | `Run without asking > the tidy runs with no card, and a change sends one notice line` |
| T-0588-M8 | packages/bot/src/tidy.ts | `botChatReplying` always said no chat was replying | `Run and Skip > a Run waits while a chat of the bot is writing a reply` |
| T-0588-M9 | packages/bot/src/tidy.ts | the bot's `backgroundModel` override was ignored | `Run without asking > the model is the harness's declared background model, and a bot setting overrides it` |

## T-0590 — memory v1 follow-ups, bot directories and the nightly tidy

| id | file | mutation | failing test |
|---|---|---|---|
| T-0590-M1 | packages/bot/src/bot.ts | `mergeInto` removed a destination file and renamed the old one over it | `the default bot's directory > an old file with the same name does not write over the one already in default` |
| T-0590-M2 | packages/bot/src/bot.ts | the move wrote no marker when the old home was absent, so a later read scanned journals | `the default bot's directory > a home without the old directory is marked done and reads no journal` |
| T-0590-M3 | packages/bot/src/bot.ts | `siblingDirectories` skipped a bot directory not named in the settings when the bot was default | `memory and the other bots' directories > the default bot denies another bot's directory on disk even when the settings do not name it` |
| T-0590-M4 | packages/bot/src/bot.ts | the grants rewrite used a lock of its own instead of the file's normal writer's lock | `grants after the move > the rewrite waits for the lock the grants file's normal writer holds` |
| T-0590-M5 | packages/bot/src/bot.ts | an invalid grants file made the rewrite fail, so its marker was never written | `grants after the move > a grants file that is not JSON is left alone and marked as handled` |
| T-0590-M6 | packages/bot/src/index.ts | the move ran even when the default bot named its own cwd | `the default bot's directory > a default bot with a written directory keeps it and its old home is left alone` |
| T-0590-M7 | packages/bot/src/bot.ts | radian's journal rewrite changed every journal, not only one naming the old workspace | `harness sessions after the move > radian's journal records the new workspace and other journals are untouched` |
| T-0590-M8 | packages/bot/src/bot.ts | claude's move deleted the new project directory before merging the old one | `harness sessions after the move > claude's project directory moves to the directory named for the new working directory` |
| T-0590-M9 | packages/bot/src/tidy.ts | `launch` left the card running when `bot:chat` opened no chat | `Run and Skip > a launch that opens no chat leaves a failed card, not a running one` |
| T-0590-M10 | packages/bot/src/tidy.ts | `resume` skipped a running card with no chat id | `Run and Skip > a running card with no chat is reported failed when the source resumes` |
| T-0590-M11 | packages/bot/src/tidy.ts | an automatic tidy that failed sent no notice | `Run without asking > an automatic tidy that fails sends one notice line` |
| T-0590-M12 | packages/bot/src/tidy.ts | a requested Run checked its work before waiting for a replying chat | `Run and Skip > a requested Run does not check its work on every tick while a chat is replying` |
| T-0590-M13 | packages/bot/src/tidy.ts | an automatic tidy checked its work before waiting for a replying chat | `Run and Skip > an automatic tidy does not check its work on every tick while a chat is replying` |
| T-0590-M14 | packages/bot/src/tidy.ts | `chatsToCheck` counted a tidy run's own chat as work | `the nightly memory check > a tidy's own chat is not counted as work for the next check` |
| T-0590-M15 | packages/bot/src/tidy.ts | a failed tidy run was stored as a result | `Run and Skip > a tidy run that fails leaves a failed card` |
| T-0590-M16 | packages/bot/src/tidy.ts | the first check ran the night it found instead of only setting a baseline | `the nightly memory check > the first check only sets a baseline` |

## T-0599 — the nightly tidy's link lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0599-M1 | packages/bot/src/tidy.ts | `linkPrompt` added its heading and guidance even when every list was empty | `the link lists in the tidy prompt > a list with something to look at is in the prompt, and empty lists add nothing` |
| T-0599-M2 | packages/bot/src/tidy.ts | the prompt passed an empty report to `linkPrompt` instead of the work's lists | `the link lists in the tidy prompt > the check reads the wiki and this bot's memory from the link table` |
| T-0599-M3 | packages/bot/src/tidy.ts | `tidyWork` returned empty link lists instead of reading the link table | `the link lists in the tidy prompt > the check reads the wiki and this bot's memory from the link table` |

## T-0599 rework 1 — the nightly tidy's link lists

| id | file | mutation | failing test |
|---|---|---|---|
| T-0599-M4 | packages/bot/src/tidy.ts | `linkLists` read a link table even with no home to locate it | `the link lists in the tidy prompt > a check with no home reads no link table` |
| T-0599-M5 | packages/bot/src/tidy.ts | the memory report covered every bot's memory instead of this bot's owner | `the link lists in the tidy prompt > the memory lists stay with this bot's memory` |
| T-0599-M6 | packages/bot/src/tidy.ts | a link table that could not be opened failed the check instead of leaving empty lists | `the link lists in the tidy prompt > a link table that cannot be opened leaves empty lists instead of failing the check` |

## T-0635 — one elapsed format

| id | file | mutation | failing test |
|---|---|---|---|
| T-0635-M8 | packages/bot/src/schedule.ts | `lateText` wrote the minutes after an hour in the plural always | `lateText > counts hours and the minute left in words, singular or plural` |
