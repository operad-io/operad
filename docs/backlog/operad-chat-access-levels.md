# Chat access levels

Status: decided by the owner on 2026-11-17; not built. Touches ADR 0025 (access
profile), ADR 0028 (repository and bot chats) and the chat plugin's ADRs.

## Why

A person who answers `Always allow` is still asked again: an `Always allow`
entry (ADR 0025 D7) binds one exact command or path and working directory, so
the next command with other arguments asks again. The owner wants to choose
once, in a chat, how much the agent may do, and not be asked again in that
chat until they change it.

## Decisions (owner, 2026-11-17)

1. **A level belongs to one chat.** It is chosen in the chat and recorded on
   it, like its model and effort (a `chat.access` fact naming who changed it,
   from what and to what). Every later reply of that chat uses it, across
   restarts and clients, until someone changes it. Other chats are not
   touched; a new chat starts at its default level.
2. **Four levels.** User-visible names (approved words), Chinese and English:

   | id | 中文 | English | What the agent may do without asking |
   |---|---|---|---|
   | `plan` | 仅规划 | Plan only | read, and run commands known to only read; no write |
   | `ask` | 逐次确认 | Ask each time | read; every write and every command not known to only read asks |
   | `edits` | 自动接受编辑 | Accept edits | read and write files in the working directory; a command not known to only read asks |
   | `full` | 完全访问 | Full access | everything the profile does not deny; nothing asks |

   The menu's title is 权限模式 / Access. A level only loosens or tightens the
   asks; the profile's deny lists (paths, commands, secrets) hold at every
   level, `full` included. `full` is shown in the error colour with its risk
   in one line.
   A level judged by a model ("smart approval") is not offered now.
3. **Defaults.** A repository chat starts at `plan` (today's read-only start);
   a bot chat starts at `ask`. A bot's or repository's profile may still be
   stricter than a level: the stricter rule wins.
4. **Repository chats write only in a worktree.** Raising a repository chat
   that still works in the main clone to `edits` or `full` first opens its
   worktree (`work/chat-<id>`, the same path as today's worktree answer, ADR
   0028), then applies the level there; the main clone stays read-only, and
   changes reach main only through a task, as today. `ask` in the main clone
   keeps today's worktree question for a write.
5. **Bot chats write in place.** A bot chat at `edits` or `full` writes in the
   bot's own directory directly; no worktree.
6. **How it is chosen.** A chat action `chat:access` with the level as its
   argument, shown as the command `/access` like `/model` and `/effort`, and a
   picker in the clients' composer (desktop mock: the "operad desktop mocks"
   canvas). The chat's row shows the level when it is not the default.
7. **`Always allow` stays.** It still remembers one exact call in the user
   layer for every chat; a level is the per-chat choice.

## Open

- Whether `codex` and `radian` can carry each level; a harness that cannot
  must refuse the level at the reply's start rather than ignore it (ADR 0025 D2).
