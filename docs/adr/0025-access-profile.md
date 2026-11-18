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

A dev task worker is the exception: it starts from the default's deny rules but not its ask rules, so the inline-code ask those rules trigger does not stop a worker's scripted edit. A worker works in its own worktree and its change reaches main only through checks, review and a merge. A flow profile still adds: it cannot remove a default deny, and its own asks still hold. Chats and other generated steps keep the default in full, asks included. A worker is never stopped because of the default: a command the matcher cannot follow (inline code, a shell expansion, a path after a directory change it cannot follow) is allowed for a worker, where a chat would be asked or refused; only a plain match of a deny refuses it. No person is there to answer a worker's question, and its change still passes checks, review and a merge.

### D10: A run no person started asks before every outward write

A run is **person-started** when a person wrote a message in the run's chat
(`personStarted` in `@operad-io/harness-process`). Every other run — a schedule,
a webhook, incoming mail, another event — is a background run. In a background
run, an **outward write** asks a person before it happens.

An outward write is a message, mail or post sent out; a `git push`; or a write
call to an outside service. It is not outward when it goes to one of the owner's
own channels (the Telegram chat the owner talks to operad through, the desktop
and iOS clients) or to any target named in the profile's allowlist.

The question is a pending item (D4, ADR 0008). Its prompt names the target as a
person reads it — who, which channel or conversation, which repository and
branch, which service — and carries the whole content being sent. Its choices
are `send_once`, `allow_target` (`Send once`, `Always for this flow and target`)
and `reject_once` (`Reject`); D12 says what the middle choice records. In a
background run the chat's exact-call `alwaysAllow` (D3) does not count: the
pending item asks even when the same exact call was allowed in a chat. The
allow-always user layer is still not read or offered in such a run; only the
target grants of D12 lift the question.

Every path is judged the same way, not only a tool call an agent makes through
a harness: a plugin step or action that sends or calls out by itself goes
through the same check.

### D11: How an outward write is recognised

The profile has two more fields:

- `outwardCommands` is a list of command rules in the shape of `askCommands`
  (`git push`, `gh pr create`, `gh issue comment`, `curl`, `wget`, `mail`,
  `sendmail`, …). A matching `bash` part is an outward write in a background
  run. The target is read from the command where it can be: `git push origin
  main` names `origin/main`; a `curl` write names its URL; a mail command names
  its recipients; otherwise the whole command is the target. A `curl` without a
  write method or body, and a command whose own write shape is not recognised,
  is not outward.
- `outwardAllow` is a list of target strings a background run may write to
  without asking: a channel and conversation (`telegram:123`), an address, a
  repository and branch (`origin/main`), or a service. The list holds `owner`
  for the owner's own channels; a plugin marks a write to one of those with
  `owner: true`, so a digest to the owner's Telegram does not ask while a
  message to another chat does. A target is matched exactly.

A plugin step or action that writes outward declares it in its plugin
declaration: `reachesOutside: true` and `outward(input)`, a function that names
the target and content of one call (`OutwardWrite` in the engine types:
`channel`, `mail`, `post`, `repository`, `service` or `command`). A step or
action that marks itself as reaching outside but names no target counts the
whole call as an outward write, so nothing about it can be allowlisted and it
asks. The kernel carries these two fields because a step and an action are
declared to the kernel; it reads no meaning into them. The matcher, the
question and the guard live in `@operad-io/access-match`, and a plugin calls
that guard before it sends.

An MCP tool not on the profile's `allowMcp` list already counts as a write. In a
background run that write is also outward, with the service and tool as its
target (`mcp <server>.<tool>`); a tool the allowlist names is not outward. The
check has the same place the bot guard already has in front of a server's tools.

`@operad-io/harness-process` sets `background: true` on the profile it hands a
worker when no person started the run. The matcher then treats an outward
command or MCP call as an ask, and the host turns it into the pending item of
D10. The harness flows that carry a question to a `wait_person` keep their
existing permission choices; a question answered while the step is alive uses
`send_once`.

What was looked at: the Telegram senders (replies, commands, pending items, progress) are a source plugin, not a step or action, and every target is a chat that a listed owner user opened with operad, so they are owner channels and not outward. A bot proposal writes only local files, and only after a person approves it. A chat reply goes to the chat's own bound channels, also owner channels. `shell/command` and `shell/check` declare `reachesOutside` and guard each line; `dev/integrate` declares it and guards its push with the repository and main branch as the target. This decision does not cover the paths that start a process without the profile: `shell/probe`, the other git and editor commands of `dev`, and a bot's MCP server start.

### D12: A target grant binds a flow definition and one outward target

The third answer, `allow_target`, records a grant instead of answering only this
write. A background run of the same flow after the answer, writing to the same
target, does not ask; another target asks; a changed flow definition asks
again.

The grant is bound to the flow's definition identity, never to the content that
is sent: a daily digest with new text each day to the same chat stays allowed.
The identity is a generated id kept beside the digest of the definition last
seen. Every time the digest differs from that last digest a new id is made, so
an edit asks again even after it is reverted, because reverting is another
change from the digest last seen. A grant entry carries the flow name, that
identity, the outward kind, the exact target, who answered and when.

The grants are access data, not kernel data, and live in
`$OPERAD_HOME/access-grants.json`, the user layer beside `access-user.json`.
The file is JSON with a Schema, hand-editable, written under the platform file
lock and replaced whole. It lives in `@operad-io/access-match`, not in the
harness package that owns `access-user.json`, because the shell and dev steps
call the outward guard there without loading a harness; `guardOutward` both
checks a grant and records one. A file that cannot be read is reported by the
step and treated as empty.

The owner lists and removes grants through the `allow` action on a repository,
which the owner already reaches through `dev`: `operad dev:allow` lists them
and `operad dev:allow <repo> --target <target>` removes the grants of one
target (optionally only one flow's). The same action is reachable through the
HTTP and MCP action paths, so a client can show the list. A removed grant
asks again on the next write. The action and its output use the existing word
`allow`; they add no user word.

The exact-call `allow_always` of D3 still does not count in a background run,
whether it was answered in a chat or earlier for the same call. Only these
target grants lift the background question.
