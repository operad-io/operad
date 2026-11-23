# @operad-io/memory

**The memory plugin.** It owns the shared wiki and a bot's memory: a Markdown
directory with a git history, a SQLite FTS5 index of the wiki, the memory and a
bot's chats, the `memory` skill every bot mounts, and the commit that records
what a bot reply wrote. A new home turns it on; a home made before needs
`operad plugin enable memory`.

This package is part of [operad](https://github.com/operad-io/operad). Most people install only [`@operad-io/cli`](https://www.npmjs.com/package/@operad-io/cli).

## Documentation

- User guide: [docs/user/memory.md](https://github.com/operad-io/operad/blob/main/docs/user/memory.md)
- Website: <https://operad.io>
- Developer reference: `REFERENCE.md` in this directory

MIT licensed.

## Memory regression set

Cases are exchanges where the bot got something wrong or the person corrected it
(a correction counts as a miss): the context it had, the question and the right
answer. They contain private chat text, so they live in the operad home
(`~/.operad/memory-cases/<id>.json`, schema `memory-case.schema.json`), never in
this repository. `examples/` holds a synthetic set and its memory.

- `memory score [--cases <dir>] [--bot <name>] [--memory <dir>] [--window <n>] [--no-record] [--answer-with <program> [args]]`
  runs the set against the bot's current memory and appends the score, the
  settings it was taken under and the per-case pass/fail (ids only) to
  `memory-scores.jsonl` in the home. It prints the change since the last run of
  the same set.
- `memory propose [--chat <id>]` finds corrections in the chat record and stores
  each as a pending proposal. Approve it with the phrases a right answer states
  (one phrase per line, and optionally the wrong phrases); reject it to drop it.
  Nothing is added to the set without approval.

**Scoring is by exact phrases, not a model judge.** A case passes when every phrase
is stated (ignoring case, spaces and punctuation) and no `avoid` phrase is. A
judge adds its own drift to a number whose job is to show the memory's drift,
costs a call per case, and a fixed rubric does not remove either. The phrases are
short phrases the person approved. The cost is that a right answer in other
words fails; write the phrase as the part that must not change (a name, a date).

The default answerer needs no model: it assembles what the bot would have in
front of it (the last `--window` messages, as a compaction keeps them; the memory
index cut at its limit; what a memory search of the question returns, including
the messages the window dropped) and scores that. `--answer-with` runs a program
that gets `{question, context, memory}` as JSON on stdin and prints an answer, to
score a real bot.
