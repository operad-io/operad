# `@operad-io/memory`

The `memory` plugin. The shared **wiki** is a Markdown directory every bot can
read; a bot's **memory** is `memory/` inside its own working directory. Both are
git repositories. Optional: `operad plugin enable memory`.

## Settings

The `memory` section of `config.json` (`plugins.memory.settings`), checked
against `memory.schema.json` and editable through the settings interface:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `wikiDir` | string | `wiki` under the home, so `~/.operad/wiki` usually | The shared wiki: created when missing, and made a git repository when it is not one. A directory that is already a git repository is used as it is: never initialised again, never restructured. `~` is the user's home; a relative path is under the operad home. |

The default is the relative path `wiki`, so it resolves under whichever operad
home is in use: a home other than `~/.operad` gets its own wiki.

## The skill

`skills/memory/SKILL.md` is mounted for every bot while the plugin is enabled.
`resolveBot` appends `MEMORY_SKILL_DIR` to the bot's skills; `memoryEnabled(home)`
reads `plugins.memory` from `config.json` (enabled unless `enabled` is `false`).
The skill is static text; the wiki's current path is a setting, not a value
written into the skill.

## The layout

`ensureMemoryLayout(memoryDir)` makes `index.md`, `instructions.md` and `log/`
when they are missing and never overwrites them. A topic note is
`topics/<name>.md`, linked from the index.

## The commit

The plugin declares one step, `memory/commit`, called by a chat after a reply
when its refresh data names it. `bot/settings` returns
`after: "memory/commit"` only when the step is loaded (`ctx.stepLoaded`), so a
home without the plugin is unaffected. `chat/reply` calls the named step after a
round that ended `done` or `failed`, and `chat/keep` calls it for a run that was
stopped or interrupted after writing. A step that fails is logged and never
changes the answer.

`runMemoryCommit(ctx, params)`:

1. reads the chat from `params.chat` (or `ctx.object`), and its `parent`
   (`bot:<name>`) and `cwd`; a chat that is not a bot's is skipped;
2. makes the memory layout, and removes `memory/index.md` lines that link to a
   note whose frontmatter says `untrusted: true`;
3. makes the bot's `memory/` a repository of its own when it is no repository
   (a memory directory already inside a repository stays part of it);
4. makes the wiki (`ensureWiki`) and commits each directory that changed.

One commit per repository that the reply changed, with the subject
`memory: bot <bot>, chat <chat>` or `wiki: bot <bot>, chat <chat>`. Only that
directory's paths are staged and committed, so another change in the same
repository is not taken along. The step cannot attribute a change inside those
paths to the bot or to a person: every uncommitted change under the directory
when the reply ends goes into the commit. The commits are made with a fixed identity
(`operad memory <memory@operad.local>`) and `--no-verify`, so a fresh repository
without `user.name` still records the write. Commits in one home take turns
under `$OPERAD_HOME/memory-commit.lock`.

## The wiki and a bot's access profile

The `bot` plugin asks this package for the wiki path (`wikiDirectoryOfHome`) and
whether the plugin is enabled. `defaultAccess(home, wikiWrite)` names the wiki in
the home deny even before it exists; a bot that may write it leaves that entry
out, and a bot that may only read it also gets a `readPaths` entry so a read
reaches it through the deny. A bot's `writeWiki` setting decides; without it the
default bot writes and every other bot reads (ADR 0030).

## Not here yet

No full-text index (`bun:sqlite` FTS5 is planned), no `capture` or `review`
flow, and no per-run record of the material a bot read: the `untrusted` mark is
written by the bot itself, and the plugin only enforces that a marked note is not
indexed.
