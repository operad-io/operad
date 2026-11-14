# ADR 0025: The Access Profile

Status: accepted

## Background

Generated steps and conversations run agents that can read files and run commands. A sandbox shell is the real boundary; until it exists, and beside it afterwards, a profile of forbidden paths and dangerous commands is the guardrail. The profile is not a boundary: it holds back mistakes and the common abuse, and the sandbox shell is what contains an agent that tries to leave. Rules that proved right in OpenClaw's approval layer are taken directly.

## Decisions

### D1: The access profile is operad's own JSON

It is a JSON document with a Schema, attached to a flow, a conversation or a repository's settings. It holds lists of denied and asked-about paths and commands. The kernel does not interpret it; it hands it to the harness step (ADR 0010 D3).

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

The user layer is a JSON file with a Schema that a person can open, edit by hand and undo by deleting a line; every conversation and harness reads the same file. Each entry binds the exact command (or tool plus path) and working directory, only releases a call that would otherwise be asked about, and never touches a deny rule. The answer itself is the answer to a pending item, and the history records who, when and in which conversation; the rule is not written into the fact log, and the kernel still does not interpret the profile.
