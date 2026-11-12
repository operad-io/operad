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
