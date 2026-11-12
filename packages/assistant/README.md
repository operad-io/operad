# `@operad-io/assistant`

The `assistant` plugin. Its object is a **profile**: a working directory, a
default harness, skills and an access profile. A profile is one row in lists and
the parent of its chats. The chat itself belongs to the `chat` plugin.

Optional: `operad plugin enable assistant`.

## Settings

The `assistant` section of `config.json` (`plugins.assistant.settings`), checked
against `assistant.schema.json` and editable through the settings interface:

```json
{ "profiles": { "reader": { "harness": "pi", "skills": ["~/skills/brain"], "access": { "readOnly": true } } } }
```

`default` exists even when it is not written. A profile name is lowercase letters,
digits, `-` and `_`. Fields: `cwd`, `harness`, `skills`, `access`.

- **Working directory**: `~/.operad/assistant/` for `default`, `~/.operad/assistant/<name>`
  for another profile, created when missing. A `cwd` that is the operad home, holds
  it, or is inside it outside `assistant/` is refused: the chat works in a
  subdirectory, never the home.
- **Access profile**: the default one (no credentials, no shell profile writes, no
  `operad` command; the agent uses operad's tools) plus what the profile adds. A
  profile can tighten it, never loosen it. Everything in the operad home except
  `assistant/` is in `denyPaths` (what is there now, and `store`, `secrets`,
  `config.json`), so the fact log, secrets and the token are out of reach.
- **Skills**: directories with a `SKILL.md`, given to the harness as `skills` in its
  step params. A missing `SKILL.md` fails the reply and names the directory.

## `assistant:chat <profile> [--harness <name>] [--title <text>]`

Creates a `chat` with the profile as parent. The harness is the one given, else the
profile's, else the first loaded one; it is fixed once chosen. The chat reaches
repositories only through operad's tools (`operadTools`) and `dev`'s verbs, never by
editing their files: the paths of the repositories `dev` knows are in `denyPaths` (read again at every reply, so a repository added later is covered), its directory is not a repository and `operad` is a denied command.

At every reply the chat runs the step `assistant/profile`, which reads `config.json`
again: tightening access or adding a skill applies to the next reply of the same chat.
A profile taken out of the settings, or one that cannot be used, fails the reply; it
is never answered from an older copy.

## Telegram

Chats bound from Telegram are not built here. When they are, they open with
`openChat` on `default`; a rule that names another profile goes in the same place.
