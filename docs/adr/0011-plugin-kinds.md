# ADR 0011: Plugin Kinds and Skills

Status: accepted

## Background

The loop wanted is: a user describes a need, an agent with the `operad-sdk` skill writes a plugin or the TS file of a graph node, operad hot-loads it, and it is usable at once. The danger is in the same place: a TS step written on the spot handles text that other people wrote (Telegram, a webhook, mail), and injection and arbitrary code meet there.

## Decisions

### D1: Six kinds of plugin

- `domain`: the objects, actions and flows of one field, such as `dev`.
- `harness`: who does the work.
- `source`: where work comes from.
- `stage`: a check, giving a verdict.
- `channel`: where to find a person and how the answer comes back.
- `action`: doing something outside; a forge that lands code is one kind of it.

The core knows kinds, not names. Kind names appear only in developer documents; a user does not see them. `shell`, which runs commands and checks, is a base plugin installed with operad.

### D2: Skills are `SKILL.md`

The skills that a bot and a flow use take the `SKILL.md` format of Agent Skills, so they interoperate with pi and Claude Code. operad only gives the text of a skill to an agent to read, and does not run code inside a skill directory. There is no skill market. A harness that cannot load a `SKILL.md` itself is told the skill's name, description and the path of its `SKILL.md` in the prompt (ADR 0022 D9).

### D3: A plugin may also be a source

A plugin that declares `start` is started by `serve` as a source, whatever its
kind. The kind still says what the plugin mainly is (the bot is a domain: it
owns bot objects and their actions), and `start` says it also brings work from
outside. This keeps a source that belongs to one domain's own objects in that
plugin instead of in another source plugin or in the kernel.
