# ADR 0023: The `pi` Harness

Status: accepted

## Background

pi is an in-process TypeScript library: resume, tool limits, a hook before a tool call, in-process tools, the cost of each message and cancel are all in it, without a subprocess protocol or MCP. It runs under Bun. It is the harness whose contract maps most directly, and the shape it set (a hub-side step that starts a child process whose stdin is one JSON and stdout one event per line) is the shape the other harnesses follow.

## Decisions

### D1: `pi` is an `sdk` harness with the same parameters as `radian`

The package is `@operad-io/harness-pi`, the step `pi/agent`, the flow `pi:prompt`. Parameters, result names and fact shapes are the same as `radian`'s (`AgentStepParams`, `AgentResultName`, `AgentResultData`), so a flow or `dev`'s `worker.use` switches harness by changing the step name.

### D2: The library runs in a Bun child process, not in the hub

The plugin has two halves. The hub-side `agent` step only starts `bun <worker.ts>`; like `radian` it watches the wall clock and stalls with `runAgent`, writes the log with `JsonlLog` and reads the last Result record. The child's `worker.ts` imports pi's library, reads one JSON of parameters from stdin, writes each pi event as one JSON line to stdout, and the last line is the Result. The reasons: a task that runs two hours must not take down the hub that a phone is connected to when it crashes or leaks; while waiting for a person, killing the child means "no process" and resuming means starting a new one; a sandbox shell wraps the whole child; and the shape matches Claude, whose agent is a child process. The cost is a thin line-per-JSON format and no other protocol. The shared process helpers (`process`, `jsonl-log`) live in one package that harnesses share.

### D3: The pi in the child does not discover

The child uses an explicit `resourceLoader` carrying only operad's own inline extension (no user extensions, skills, prompt templates, themes or context files), `SettingsManager.inMemory()`, and `agentDir` set to `~/.operad/harness/pi/` with session files under `~/.operad/harness/pi/sessions/`. The principle is the same as Claude's `settingSources: []`: a harness's behaviour is decided by operad's declaration, not by the user's personal configuration.

### D4: Credentials are the user's own pi login

`ModelRuntime.create({ authPath: ~/.pi/agent/auth.json, modelsPath: ~/.pi/agent/models.json })`. The user's pi uses OAuth subscriptions, not API keys, which `ctx.secrets` cannot give; pi locks `auth.json` itself, so the TUI and operad refreshing a token at the same time is within its design. The declaration has two settings, `model` and `thinkingLevel`, defaulting to the user's pi default model.

### D5: Where the facts come from

`sessionId` is the session file path; `usage` is summed from each `message_end`, with `cache_read` and `cache_write` from `cacheRead` and `cacheWrite`; `cost.micros` is the summed `cost.total` times one million rounded, and `null` for a model pi cannot price; `finalMessage` is `getLastAssistantText()`. The log is a subset of pi events (`message_end`, `tool_execution_start`, `tool_execution_end`, `agent_settled` and blocking records).

### D6: Resume

`resumeSession` is the session file path; the child opens it with `SessionManager.open(path)` and sends the new prompt into it.

### D7: The access profile is matched in the `tool_call` hook

The `tool_call` handler receives the access profile and judges each call with the shared `access-match` module (ADR 0025): `bash` commands are split along `&&`, `;` and `|` and each part matched; inline code (`bash -c`, `python -c`, `node -e`, `osascript -e`, `find -exec`, `xargs`) is refused outright; the paths that `read`, `write`, `edit` and `bash` touch are matched against the path rules. A refusal returns `{ block: true, reason }` and the log records a block. A profile that needs a field the harness does not enforce is refused at start, naming the field (ADR 0010 D3).

### D8: Asking a person happens in the handler

`tool_call` is async, so the handler awaits `ctx.ask(...)` (ADR 0008): an answer within the grace period lets the call go; a timeout returns `block` and `abort()`, and the step ends `waiting` with the session path; resume opens the original file, and a one-time grant lets exactly that call through.

### D9: pi is not bundled; the user's pi is used

`@earendil-works/pi-coding-agent` is not in `dependencies`, only in `devDependencies` for types and the fake model in tests. At start the worker finds the library: it takes the real path of the `pi` command on `PATH` (the setting `command` changes it), walks up to the directory whose `package.json` `name` is `@earendil-works/pi-coding-agent`, and `import()`s the entry its `exports["."]` names. A global install by bun or by npm has this shape. The worker's import of the library is dynamic, with `import type` for the types. `operad plugin check` reads that `package.json`'s version and refuses, naming both versions, when it is below the floor the worker was written for (currently `1.5.0`) or when there is no `pi` command. Upgrading pi is the user's job; when an interface the worker uses changes, operad changes the floor.
