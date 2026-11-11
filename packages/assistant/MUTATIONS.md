# Mutation records — `assistant`

Rows whose mutation broke code in `packages/assistant/` or the `chat` reply it
changes for profiles, in the order they were recorded. The root
[MUTATIONS.md](../../MUTATIONS.md) explains the format and the row fields.

| id | file | mutation | failing test |
|---|---|---|---|
| T-0189-M1 | packages/chat/src/reply.ts | the reply used the chat's own copy of the access profile, not the one its profile gives now | `a reply reads the profile again > tightening the access profile applies to the next reply of the same chat` |
| T-0189-M2 | packages/assistant/src/profile.ts | the default access profile did not deny the operad home's contents | `the default access profile > a chat of the default profile cannot read the secrets or the token, and can read its own directory` |
| T-0189-M3 | packages/assistant/src/profile.ts | a working directory that holds the operad home was accepted | `profiles > a working directory that is the operad home, holds it, or is inside it outside assistant is refused` |
| T-0189-M4 | packages/assistant/src/index.ts | a chat was made without naming its profile step | `a reply reads the profile again > a skill added to the profile is given at the next reply; none before` |
