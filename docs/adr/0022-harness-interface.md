# ADR 0022: The Harness Interface

Status: accepted

## Background

operad lists and drives sessions of any coding agent on the machine and starts tasks on them through one description of each harness. The agents expose different programmatic interfaces: Claude has an Agent SDK that holds resume, permission callbacks, tool limits, hooks, in-process MCP and budgets together; Codex's real interface is the app-server JSON-RPC, on which an ACP adapter is built; Gemini has only `--acp` and `-p`; pi is an in-process library. Unification can only happen on the operad side. Sessions, pending items and answers a user sees are operad's objects, never those of any vendor's protocol.

## Decisions

### D1: The harness interface is operad's own

A harness is a plugin of kind `harness` with a name, a way of starting, a connection kind (`sdk` or `acp`) and declared capabilities (resume, usage, tool-set limits, permission mode, conversation view, cancel). A one-off task run and an interactive session run use the same declaration. A new kind needs only its declaration and the connection code, and `operad plugin check` runs the harness contract.

### D2: Two reference connections

`sdk`: the harness's official library runs inside an operad process as a client, and the agent stays a child process. `acp`: an ACP client (`session/new`, `session/load`, `session/prompt`, `session/cancel`, the `session/update` stream, `request_permission`), one piece of code for every harness with an ACP entry. Both give the same facts for the declared capabilities.

### D3: Which connection each harness uses

- `claude` uses `@anthropic-ai/claude-agent-sdk` (`sdk`); `pi` uses `@earendil-works/pi-coding-agent` (`sdk`, ADR 0023 and ADR 0024).
- `radian` uses `radian acp`; `codex` uses `codex-acp`; other harnesses use their own ACP entry (`acp`).
- The built-in command adapter stays as the fallback for tools that can only run once and cannot interact: the prompt goes in, the last message comes out, and the receipt is a JSON code block at the end of the message. It has no session face. A receipt holds at least `done`, `nothing`, `failed`, `needs_decision` or `waiting`, and `waiting` carries `wait_check`.

### D4: Permission requests are answered by operad

A permission request (ACP `request_permission`, the SDK's `canUseTool`) is answered by the engine according to the access profile of the run, or handed to a person on the phone; the harness never makes the permission decision. Each harness enforces the profile through a mechanical deny table of its own. A person's approval unlocks one call of that run once.

### D5: radian is only an agent

`radian` calls only `radian exec` and `radian acp`. operad does not call, start or depend on `radian hub` or `radian arc`, and `dev` neither reads nor writes `.radian/arc/` in a repository. Orchestration (plans, tasks, gates, merge, push) lives only in operad.

### D6: The harness itself is the user's, not operad's

operad does not install a harness. radian is a command on `PATH`; pi is found from the `pi` on `PATH` and its library imported from there; Claude is started from the `claude` on `PATH`, and operad carries only the Agent SDK client code, with the eight platform binary packages replaced by empty packages through `overrides`. The reason: login state, auto-update and quota belong to the user's own installation, and operad should neither download a binary of hundreds of megabytes for the user nor log in for them.

The version coupling follows. The client library operad carries is not pinned: `package.json` holds a range, the lock file records the version last tested, and `bun update` moves it forward. The harness itself has a version floor. `operad plugin check` reports both versions and refuses only when the harness itself is too old or not logged in.

### D7: A harness is named after the agent it connects

The plugin name is `claude`, `pi`, `radian` or `codex`: the `plugins.<name>` of `config.json`, the step `claude/agent`, the flow `claude:prompt`, `worker.use` of `dev.json` and the harness a chat stores all use that name, and it is what the interface shows. A form such as `harness-claude` is only the npm package name (`@operad-io/harness-claude`), which a user never sees. The packages live under `packages/harness/`: `claude`, `codex`, `pi`, `radian`, `process`.

### D8: The `codex` harness

The plugin is `codex`, the package `@operad-io/harness-codex`, the step `codex/agent`, connection `acp` (D2). It starts the user's own `codex-acp`; the default command runs the `codex-acp` on `PATH` with the `bun` on `PATH`, because its `#!/usr/bin/env node` finds node only in some shells; the setting `command` changes it. The credential is the user's ChatGPT login of their own Codex, which operad does not touch (D6). The model can use Codex's own image generation.

- Usage: a subscription login has no money cost, so cost is recorded as unknown and does not block budget checks; each attempt records the number of image generation calls (the quota counts generations); each tool call from the `session/update` stream is recorded in the step log so a rework can look it up.
- Time: an image generation can take minutes without output, which is normal; the worker's `stallSecs` and `wallTimeSecs` set the limits, and the harness does not decide a stall of its own.
- Sandbox: Codex's own sandbox cannot write `.git`, so a flow that uses it has its `work` stage set `commit` (ADR 0020 D9); it needs network access and write access to the task's working directory.
