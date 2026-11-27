# ADR 0022: The Harness Interface

Status: accepted

## Background

operad lists and drives sessions of any coding agent on the machine and starts tasks on them through one description of each harness. The agents expose different programmatic interfaces: Claude has an Agent SDK that holds resume, permission callbacks, tool limits, hooks, in-process MCP and budgets together; Codex's real interface is the app-server JSON-RPC, on which an ACP adapter is built; Gemini has only `--acp` and `-p`; pi is an in-process library. Unification can only happen on the operad side. Sessions, pending items and answers a user sees are operad's objects, never those of any vendor's protocol.

## Decisions

### D1: The harness interface is operad's own

A harness is a plugin of kind `harness` with a name, a way of starting, a connection kind (`sdk` or `acp`) and declared capabilities (resume, usage, tool-set limits, permission mode, conversation view, cancel, loading skills itself, taking a message mid-run). A one-off task run and an interactive session run use the same declaration. A new kind needs only its declaration and the connection code, and `operad plugin check` runs the harness contract.

A capability is declared for the agent, not assumed by a step. `loadsSkills` says the agent loads the skill directories the step gives it; a harness that does not declare it needs those skills in another form. `takesMessagesMidRun` says the agent takes a message while its run is going; a chat hands one to it through the step's inbox after the tool calls already running. The inbox listener answers false when the run can no longer take a message, so the chat does not count it as taken. A harness that does not declare it gets no inbox, and a message waits for the next run as before.

### D2: Two reference connections

`sdk`: the harness's official library runs inside an operad process as a client, and the agent stays a child process. `acp`: an ACP client (`session/new`, `session/load`, `session/prompt`, `session/cancel`, the `session/update` stream, `request_permission`), one piece of code for every harness with an ACP entry. Both give the same facts for the declared capabilities.

### D3: Which connection each harness uses

- `claude` uses `@anthropic-ai/claude-agent-sdk` (`sdk`, ADR 0024); `pi` uses `@earendil-works/pi-coding-agent` (`sdk`, ADR 0023).
- `codex` speaks Codex's own `codex app-server` JSON-RPC over stdio. It is this harness's own connection, as `sdk` is for `claude` and `pi`, not a third reference connection (D2).
- `radian` uses `radian acp`; other harnesses use their own ACP entry (`acp`). ACP stays for `radian` and for harnesses that only have an ACP entry.
- The built-in command adapter stays as the fallback for tools that can only run once and cannot interact: the prompt goes in, the last message comes out, and the receipt is a JSON code block at the end of the message. It has no session face. A receipt holds at least `done`, `nothing`, `failed`, `needs_decision` or `waiting`, and `waiting` carries `wait_check`.

### D4: Permission requests are answered by operad

A permission request (ACP `request_permission`, the SDK's `canUseTool`) is answered by the engine according to the access profile of the run, or handed to a person on the phone; the harness never makes the permission decision. Each harness enforces the profile through a mechanical deny table of its own. A person's approval unlocks one call of that run once.

### D5: radian is only an agent

`radian` calls only `radian exec` and `radian acp`. operad does not call, start or depend on `radian hub` or `radian arc`, and `dev` neither reads nor writes `.radian/arc/` in a repository. Orchestration (plans, tasks, gates, merge, push) lives only in operad.

### D6: The harness itself is the user's, except the pi operad installs for a first run

operad does not install a harness the user runs. radian is a command on `PATH`; Claude is started from the `claude` on `PATH`, and operad carries only the Agent SDK client code, with the eight platform binary packages replaced by empty packages through `overrides`; codex is the user's own `codex app-server`. The exception is pi: when no agent command is on `PATH`, operad installs a pinned `@earendil-works/pi-coding-agent` into the operad home and starts the `pi` harness from there, so a person reaches a model on a first run without installing an agent first (ADR 0023 D9). A `pi` on `PATH` is used instead, and nothing is installed then. The reason: login state, auto-update and quota belong to the user's own installation, and operad should neither download a binary of hundreds of megabytes for the user nor make a login of its own. The pi it installs is a library that uses the user's pi login (ADR 0023 D4), and radian and claude are not installed this way.

The version coupling follows. The client library operad carries is not pinned: `package.json` holds a range, the lock file records the version last tested, and `bun update` moves it forward. The harness itself has a version floor. The pi library operad installs is pinned exactly and moves with an operad release, because it is the copy a new home starts on. `operad plugin check` reports both versions and refuses only when the harness itself is too old or not logged in.

### D7: A harness is named after the agent it connects

The plugin name is `claude`, `pi`, `radian` or `codex`: the `plugins.<name>` of `config.json`, the step `claude/agent`, the flow `claude:prompt`, `worker.use` of `dev.json` and the harness a chat stores all use that name, and it is what the interface shows. A form such as `harness-claude` is only the npm package name (`@operad-io/harness-claude`), which a user never sees. The earlier `harness-*` plugin, step and flow names are not recognised, and there are no aliases. The packages live under `packages/harness/`: `claude`, `codex`, `pi`, `radian`, `process`.

### D8: The `codex` harness

The plugin is `codex`, the package `@operad-io/harness-codex`, the step `codex/agent`. It speaks Codex's own `codex app-server` JSON-RPC over stdio: this harness's own connection, as `sdk` is for `claude` and `pi`, not a third reference connection (D2, D3). It starts the user's own `codex app-server`; the default command finds the `codex` of `PATH` and starts its `app-server`, and the setting `command` changes it. The credential is the user's ChatGPT login of their own Codex, which operad does not touch (D6). The model can use Codex's own image generation.

- Usage: a subscription login has no money cost, so cost is recorded as unknown and does not block budget checks; each attempt records the number of image generation calls (the quota counts generations); each tool call from the app-server item stream is recorded in the step log so a rework can look it up. The reply's context comes from the app-server's last token usage, and its window from the `modelContextWindow` the app-server reports with it when it reports one.
- Time: an image generation can take minutes without output, which is normal; the worker's `stallSecs` and `wallTimeSecs` set the limits, and the harness does not decide a stall of its own.
- Sandbox and approvals: Codex's own sandbox stays on, and its approval policy and reviewer are set so Codex asks operad instead of deciding; the access profile answers each command and file-change request (D4). Codex's own sandbox cannot write `.git`, so a flow that uses it has its `code` stage set `commit` (ADR 0020 D9); it needs network access and write access to the task's working directory.

### D9: A harness that cannot load skills itself is told them in the prompt

A step may give skill directories to a harness (ADR 0011 D2). A harness that declares `loadsSkills` loads them itself and its prompt is only the step's prompt. Any other harness gets a short list appended to the prompt: each skill's name, the description from its `SKILL.md` frontmatter and the path of that file, with one sentence to read the file before doing what it describes. This list never carries a skill's body. The one exception is a skill a person types as `/name rest` in a chat: a harness that does not declare `loadsSkills` gets that skill's body in the message, after a line naming it and before `rest`, while a harness that declares it gets `/name rest` unchanged (ADR 0028 D9).

The list stays small: it carries at most a fixed number of skills and a fixed number of characters of each description, and says how many skills the cap left out. A directory whose `SKILL.md` or name cannot be read is left out, as D1 skips it for a harness that loads skills itself. The shared code of `@operad-io/harness-process` holds this, so a new harness gets it without writing its own.

### D10: A harness declares each model's context window

A harness's model list may carry `windows`, a map from a listed model to its context window in tokens. The window is a positive whole number; a model whose window the harness does not know has no entry. The value is a declaration about the agent's own model list, so a chat can show how full the context is without guessing; a harness that learns the window at run time may also report it with the run's context.

`claude` declares the window of each model it lists, including the 1M variants. `pi` reads the context from its own model registry. `codex` reads it from the model information its app-server reports when it reports one. A model with no known window leaves it out.

### D11: A harness describes each model it lists

A model in a harness's `models.list` is either its id, as before, or a description of it. A description has the model's `id` — the string a chat stores, unchanged — and may carry a display `name`, a `provider`, its context `window` and the `capabilities` it truly knows. A `models.info` object may carry the same descriptions by id instead; a bare string list stays valid, so a harness that knows nothing more still works.

The capabilities are `vision` (accepts images), `reasoning`, `tools` and `web` (has its own web search). A harness declares only what it knows: a field or capability it cannot tell is absent, never guessed. The `window` is the same fact as the `windows` entry of D10; a harness may give either, and both are exposed.

The descriptions reach a client wherever `/v1` already gives a harness's models: the plugin list carries the harness's `models`, and an action argument that names a model carries the descriptions in its `info`, keyed by id. A client that reads only the ids keeps working. Clients may label the list and the capabilities in their own words; the server adds no user text. `claude` describes anthropic models with vision, reasoning and tools. `pi` takes the provider, name, vision and reasoning from its model registry. `codex` passes on what its app-server reports.

### D12: A harness may declare its background model

A harness's capabilities may carry `backgroundModel`, the model it prefers for
work a person did not start and that should cost little, such as a bot's memory
tidy (ADR 0030 D13). It is a model id the harness lists, so a chat that uses it
still checks it against that harness's list. A harness that leaves it out has no
cheap default and a bot falls back to the bot's own model, else the harness's
default model. `claude` declares `haiku`; `pi`, `codex` and `radian` leave it
unset. operad never compares prices: the choice is the harness's declaration,
and a bot's own setting may override it.

A source that needs it reads the declaration through
`ctx.harnessCapabilities`, beside `ctx.harnesses`, the loaded harness names.

### D13: A harness may offer a login step

A harness may declare a step named `login` (`<harness>/login`) that logs a
person in with the harness's own providers and returns the model they chose:
the result `done` with `data.model`, a model id the harness lists, and
`data.provider`, or `failed` with `data.message`. It runs where the harness's
agent steps run and asks through `ctx.ask` (ADR 0008). A harness whose login is
the user's own, such as claude, radian or codex, declares none.

A plugin that owns an object whose agent is a harness, the bot plugin,
calls the step by the agent's name through `ctx.runStep`. The call is by data,
so the caller lists no step and a harness it does not load costs nothing. The
step owns only the provider login and the settings that name the chosen model
are the caller's.

### D14: A harness says whether its agent is on the machine

A harness plugin may declare `agentMissing(settings, context)`: one sentence saying how to set its agent up when the agent is not on this machine, and nothing when it is. It is asked each time, so an agent installed while `serve` runs is found. While it answers a sentence the plugin stays loaded and its steps exist, but the harness is not set up: it is not among the agents offered to a plugin, its sign-in and model list are not asked, and its check passes with the one missing item `agent` (ADR 0010 D7) instead of failing. A harness answers a sentence only for its default command: `claude`, `codex` or `radian` not on `PATH`, and for `pi` neither on `PATH` nor installed in the home. A command the owner set is judged by the check, so a wrong one is reported as a failure. The reason: every shipped harness that can load without its agent is on in a new home (ADR 0012 D2), and an agent a person does not have must not be chosen for a chat, ask for a login or report a failure at each start.
