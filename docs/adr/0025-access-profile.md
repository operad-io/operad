# ADR 0025: The Access Profile

Status: accepted

## Background

Generated steps and conversations run agents that can read files and run commands. A sandbox shell is the real boundary; until it exists, and beside it afterwards, a profile of forbidden paths and dangerous commands is the guardrail. The profile is not a boundary: it holds back mistakes and the common abuse, and the sandbox shell is what contains an agent that tries to leave. Rules that proved right in OpenClaw's approval layer are taken directly.

## Decisions

### D1: The access profile is operad's own JSON

It is a JSON document with a Schema, attached to a flow, a conversation or a repository's settings. It holds lists of denied and asked-about paths and commands, and of paths a read may reach under a denied directory (`readPaths`); a write there stays denied. The kernel does not interpret it; it hands it to the harness step (ADR 0010 D3).

### D2: Enforcement belongs to the harness plugin

Each harness translates the profile into its own mechanism: `radian` into permission rules and a tier; `claude` into `canUseTool`, where the deny and ask rules are judged (ADR 0024 D6); a command adapter that has no permission mechanism accepts only deny rules and refuses a profile that has `askCommands`. A field a harness cannot translate is declared unsupported in its declaration, and the run is refused at start instead of the field being ignored.

### D3: Four rules taken from OpenClaw

- An approval can only tighten the configuration, never loosen it.
- "Always allow" binds the exact argv and working directory; another directory is a new question.
- Inline code (`bash -c`, `python -c`, `node -e`, `osascript -e`, `find -exec`, `xargs`) is matched again by its inline content, and when it cannot be matched it is asked about.
- Every part of an `&&`, `;` or `|` chain must pass.

What the shell matcher cannot see is asked about, not allowed.

### D4: An ask is a pending item

An ask is a pending item whose object is the conversation or the task; any client (phone, Telegram, command line) can answer it. There are three answers: `allow_once`, `allow_always` (bound to argv and working directory) and `reject_once`.

### D5: Secrets do not enter a step

A scoped secret is injected by the harness or a fetching step at the boundary into the specific HTTP call; the step's environment holds no bare secret, and the path rules keep it from reading a secret file.

### D6: The sandbox shell is the second layer

The profile is a guardrail, not a boundary. When a sandbox shell wraps any command, the profile becomes the shell's input, in the same format.

### D7: `allow_always` is written into a user layer file

The user layer is a JSON file with a Schema that a person can open, edit by hand and undo by deleting a line; every conversation and harness reads the same file. Each entry binds the exact command (or tool plus path) and working directory, only releases a call that would otherwise be asked about, and never touches a deny rule. The worktree question of a read-only chat uses the same answer, so an `Always allow` there writes this entry and releases that exact call in every chat. The answer itself is the answer to a pending item, and the history records who, when and in which conversation; the rule is not written into the fact log, and the kernel still does not interpret the profile.

### D8: A chat's access level composes its profile

A chat's access level is one of `plan`, `ask`, `edits` and `full`. It is a field of the access profile, `level`, so every harness receives the same profile and judges it with the same matcher. The level adds asks to the profile. It never removes a deny, a secret rule, a `readOnly` rule, an `askCommands` or `askPaths` rule: the stricter rule wins.

- `plan`: the working directory is read-only, as `readOnly: true` is today. A write there and a command not known to only read ask.
- `ask`: every write and every command not known to only read asks.
- `edits`: a write inside the working directory does not ask; a write outside it asks, and a command not known to only read asks.
- `full`: the level adds no ask. The profile's own deny lists and ask lists still hold.

A level is composed into the profile by `@operad-io/access-match`; the kernel does not interpret it. `claude` and `pi` carry every level and declare `level` among the profile fields they enforce. `codex` and `radian` carry none: a reply at any level is refused at its start with a message naming the level, never answered with the level ignored.

The user-visible names are `Plan only`, `Ask each time`, `Accept edits` and `Full access` (Chinese: 仅规划, 逐次确认, 自动接受编辑, 完全访问), under the menu title `Access` (权限模式). Each level has a short description in the chat action's information; `full` says that it skips every question the level adds while the profile's deny and ask rules still hold.

### D9: One built-in default, which can only be tightened

The default profile lives in `@operad-io/access-match`, beside the matcher and free of engine internals, as `defaultAccess()`. Every chat and every generated step starts from it. A bot adds the operad home, its skills and the repositories it knows; a repository chat adds its read-only main clone and its skills; a flow may add rules to a step it generates. Each addition appends to the default's deny and ask lists and may turn `readOnly` on; none removes a default deny or ask. The access level is composed after the additions, so `full`, too, keeps the default's deny and ask rules. A harness applies the default to a generated step that names no profile. The default is shipped with operad; this decision does not add another file a user could replace it with.
