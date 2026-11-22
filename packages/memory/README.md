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
