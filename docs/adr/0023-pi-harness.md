# ADR 0023: The `pi` Harness

Status: accepted

## Background

pi is an in-process TypeScript library: resume, tool limits, a hook before a tool call, in-process tools, the cost of each message and cancel are all in it, without a subprocess protocol or MCP. It runs under Bun. It is the harness whose contract maps most directly, and the shape it set (a hub-side step that starts a child process whose stdin is one JSON and stdout one event per line) is the shape the other harnesses follow.

## Decisions

### D1: `pi` is an `sdk` harness with the same parameters as `radian`

The package is `@operad-io/harness-pi`, the step `pi/agent`, the flow `pi:prompt`. Parameters, result names and fact shapes are the same as `radian`'s (`AgentStepParams`, `AgentResultName`, `AgentResultData`), so a flow or `dev`'s `worker.use` switches harness by changing the step name.

### D2: The library runs in a Bun child process, not in the hub

The plugin has two halves. The hub-side `agent` step starts `bun <worker.ts>`; like `radian` it watches the wall clock and stalls with `runAgent`, writes the log with `JsonlLog` and reads the last Result record. The child's `worker.ts` imports pi's library, reads a JSON of parameters, writes each pi event as one JSON line, and the last line is the Result. The reasons: a task that runs two hours must not take down the hub that a phone is connected to when it crashes or leaks; while waiting for a person, killing the child means "no process" and resuming means starting a new one; a sandbox shell wraps the whole child; and the shape matches Claude, whose agent is a child process. The cost is a thin line-per-JSON format and no other protocol. The shared process helpers (`process`, `jsonl-log`) live in one package that harnesses share.

A task's worker takes one prompt and exits, as before. A chat reply may ask its worker to stay after a done reply (D10): its first input names a Unix socket under `<home>/harness/pi/kept/`, and the replies that follow find that record and send their prompt on the socket. The worker writes the same lines for each prompt, and the next reply logs them into its own run's `agent.log`, so `session`, the ready line and the timings read the same to every reader. A kept worker belongs to the home, not to the run that started it: it carries no run marker, so the step's sweep leaves it alone, and the home's record is what `serve` uses to find and end it.

### D3: The pi in the child does not discover unless a bot asks for the owner's settings

With the own-settings switch off, the child uses an explicit `resourceLoader` carrying only operad's own inline extension (no user extensions, prompt templates, themes or context files). Its skills are exactly the directories the step gives, passed as `additionalSkillPaths`; `noSkills` stays on, so nothing under `~/.pi`, `~/.agents/skills`, `.agents/skills` or `.pi/skills` is discovered. It uses `SettingsManager.inMemory()`, and `agentDir` set to `~/.operad/harness/pi/` with session files under `~/.operad/harness/pi/sessions/`. The session log names the skills loaded. pi's own automatic compaction is off (D12 says what compacts instead), and pi's retry is off unless the step asks for it: a chat reply asks, a task does not. The principle is the same as Claude's `settingSources: []`: a harness's behaviour is decided by operad's declaration, not by the user's personal configuration.

With the switch on for a bot whose agent is `pi` (ADR 0030 D9), the child loads the owner's own pi configuration through pi's own settings manager and resource discovery, rather than copying it into operad's directory. Its `agentDir` is pi's `getAgentDir()` (`~/.pi/agent`, or what pi's `PI_CODING_AGENT_DIR` names), a `SettingsManager.create` for that directory reads the user settings, and a `DefaultResourceLoader` there loads the user context files (the global `AGENTS.md` of pi and the context files pi finds from the working directory), user skills, prompt templates and extensions. The project's `.pi` resources are not trusted or loaded. operad applies its compaction and retry settings after the load: pi's own automatic compaction stays off (D12), and retry is on only for a chat reply, which uses the owner's attempt count and delays when their settings name them and pi's defaults otherwise; a task keeps retry off. Session files stay under `~/.operad/harness/pi/sessions/`; the model and login are the owner's as in D4. operad's inline extension stays, its tools are added after the owner's extensions so a shared tool name is operad's, and the skill directories the bot lists are put before the owner's so a shared skill name is the bot's. pi does not mount the bot's MCP servers, so none of their names can clash here. With the switch off, nothing in this decision changes.

A chat reply turns pi's automatic retry on and a task keeps it off. A chat can show the wait and continue the same session; a task's failure is dev's to handle through its own retry wait and fallbacks, so a second hidden retry would make the step's time and its error less predictable. The worker writes `retry_start` and `retry_end` lines for the chat's live view (ADR 0027 D9).

An extension of the owner runs in the worker process with the worker's operating-system permissions. Its factory and session-start code, its own child processes and its own network calls are not tool calls, so the access profile cannot stop them; only its tool calls are judged (D7).

### D4: Credentials are the user's own pi login

`ModelRuntime.create({ authPath: ~/.pi/agent/auth.json, modelsPath: ~/.pi/agent/models.json })`. The user's pi may use OAuth subscriptions, which `ctx.secrets` cannot give (a person logs in to one with pi itself, D11); pi locks `auth.json` itself, so the TUI and operad refreshing a token at the same time is within its design. The declaration has two settings, `model` and `thinkingLevel`, defaulting to the user's pi default model; the thinking level is sent only when the declaration or the step sets one, and otherwise pi uses its own default.

A run's model is the step's `--model` argument, else the declaration's `model`, else the `defaultProvider` and `defaultModel` of the user's pi settings file (`~/.pi/agent/settings.json`). operad resolves that default in the hub and names the model to the child on every run. With the own-settings switch off the child's settings manager is in memory (D3) and carries no default model of its own, so a child told no model selects none and the first request fails with "No API key found for the selected model" even when `auth.json` holds the credential. Reading those defaults is not resource discovery: only pi's default model and default thinking level are read from that file. When pi's settings name no complete pair, no model is sent and pi chooses its own.

### D5: Where the facts come from

`sessionId` is the session file path; `usage` is summed from each `message_end`, with `cache_read` and `cache_write` from `cacheRead` and `cacheWrite`; `cost.micros` is the summed `cost.total` times one million rounded, and `null` for a model pi cannot price; `finalMessage` is `getLastAssistantText()`. The reply's `context.used` comes from the last `message_end` alone, its input plus cache read and cache write, and `context.window` is the selected model's `contextWindow`. The log is a subset of pi events (`message_end`, `tool_execution_start`, `tool_execution_end`, `auto_retry_start`, `auto_retry_end`, `agent_settled` and blocking records).

### D6: Resume

`resumeSession` is the session file path; the child opens it with `SessionManager.open(path)` and sends the new prompt into it.

### D7: The access profile is matched in the `tool_call` hook

The `tool_call` handler receives the access profile and judges each call with the shared `access-match` module (ADR 0025): `bash` commands are split along `&&`, `;` and `|` and each part matched; inline code (`bash -c`, `python -c`, `node -e`, `osascript -e`, `find -exec`, `xargs`) is refused outright; the paths that `read`, `write`, `edit` and `bash` touch are matched against the path rules. A refusal returns `{ block: true, reason }` and the log records a block. A profile that needs a field the harness does not enforce is refused at start, naming the field (ADR 0010 D3).

The hook sees every tool call, including a tool an extension of the owner registered. When the owner's settings are on, a tool name the matcher does not know is refused while the profile has rules, because the profile cannot check it; operad's own tools stay outside those rules as they always did. This is the whole of what the profile can enforce for an extension: code the extension runs itself, at load or in a session-start handler, is not a tool call and can start its own process or network request before the hook exists.

### D8: Asking a person happens in the handler

`tool_call` is async, so the handler awaits `ctx.ask(...)` (ADR 0008): an answer within the grace period lets the call go; a timeout returns `block` and `abort()`, and the step ends `waiting` with the session path; resume opens the original file, and a one-time grant lets exactly that call through.

### D9: The user's pi is used; when there is none, operad installs a pinned pi into the home

`@earendil-works/pi-coding-agent` is not in the base install's dependencies. `@operad-io/harness-pi` names it as an optional peer, pinned to `1.6.0`, and operad installs that exact version into the home's Bun project (ADR 0012 D4) when the `pi` plugin is enabled and no pi command is on `PATH`; a `pi` on `PATH` (the setting `command` changes it) is used as it is, and nothing is installed. The pinned version moves with an operad release. A first install needs the network once; a failure names the reason and running the enable or `operad init` again retries it. The login stays the user's own pi login (D4), so operad's copy and the user's copy read the same credentials file. The library still runs in the worker child process (D2), never in the hub.

At start the worker finds the library: it takes the real path of the `pi` command on `PATH`, walks up to the directory whose `package.json` `name` is `@earendil-works/pi-coding-agent`, and `import()`s the entry its `exports["."]` names. A global install by bun or by npm has this shape. When no pi command is on `PATH`, it uses the package operad installed, `<home>/plugins/node_modules/@earendil-works/pi-coding-agent`, and that package's own `pi` command for the model list, `pi --list-models`. The worker's import of the library is dynamic, with `import type` for the types. `operad plugin check` reads that `package.json`'s version and refuses, naming both versions, when it is below the floor the worker was written for (`1.5.0`) or when there is no pi at all. When an interface the worker uses changes, operad changes the floor.

### D10: A chat reply may keep its `pi` worker

A chat whose agent is `pi` passes `keepWorker` to the `agent` step. When the reply ends `done`, its worker stays for ten minutes and the next message of the same chat is answered by it; each done reply starts the ten minutes again. The worker ends itself when that time runs out, so a `serve` that died leaves no worker for longer than that. The time and the limit of three kept workers per home are named constants, not settings. A fourth ends the one that has been idle longest.

The worker is found by a record under `<home>/harness/pi/kept/`, keyed by the chat and by a hash of what the next reply would start a worker with: model, effort, working directory, access profile, skills and MCP servers. One-time grants are not part of that hash; they belong to a reply and are sent with every prompt. A record whose key differs from the next reply is ended before a new worker starts, so another model, effort, directory, profile, skills or MCP servers never reuse it. Closing the chat, stopping its reply, and a `serve` stop or a serve that takes over new code end the kept workers too.

Access is decided per reply, never remembered by the worker: each prompt carries the reply's access profile, its asker and its grants. A question, a mid-run message and a late answer work on a kept worker as they do on a new one. A kept worker that cannot be reached, has died, or does not answer its first line in time is given up silently; the same message is answered by a new worker and the chat records no failure. The worker is ended before the new one starts, so no message is answered twice.

Only the owner may connect. The kept directory is `0700`, the record and socket are `0600`, and a record is offered only for the same home, the same chat scope and the same key; another user cannot open the socket, another chat has another scope, and another configuration has another key. The record names the worker's pid and a random token that is also on its command line; a stop verifies that token before it signals a pid, so a reused pid belonging to another program is never touched. Task workers, reviews and the other agents do not keep a worker.

### D11: A login runs in a child process and offers only API keys

`pi/login` (ADR 0022 D13) starts `bun login-worker.ts` with the rule of D2: the
library is imported only in that child, never in the hub. The child creates the
`ModelRuntime` of D4, reports the providers that can log in with an API key, and
waits for the step's commands; the step puts every prompt and question of the
login to the person with `ctx.ask` (ADR 0008) and writes the answer back on the
child's stdin. The login has 300 seconds from its start and can be cancelled; a
timeout or a cancel stops the child, and no credential is written then.

operad starts no subscription (OAuth) login, ChatGPT's included: no authorize
URL, device code or pasted redirect of one reaches a question, and the child
refuses a login command that is not an API-key one. pi's `openai-codex` login
uses the Codex CLI's own client id, and operad presenting it as its own step is
the risk the owner decided against. A person who wants their
ChatGPT plan, or another subscription (ADR 0024 D3 gives the reason for
Anthropic), runs pi's own login, `pi auth login openai-codex`. The first
question of the login says so in one line, with the command a person can run:
`pi ...` when `pi` is on `PATH` (or the `command` setting), else the full path
of the pi operad installed in the home (D9). operad only checks whether pi is
signed in, as it does for `claude` and `codex`: `signedIn` reads `authPath` on
every call, so the next check sees a login made elsewhere with no restart of
`serve`.

The providers and the models are pi's own catalog, read through the child and
`ctx.harnessModels`; operad names no provider or model of its own. The model
preselected after a login is the harness's declared default when it belongs to
the provider, else the first model the catalog lists for that provider; the
step checks the choice against the catalog before it returns. The credential is
written to `authPath` (D4). The step's result carries the model, and the caller
writes it (ADR 0030 D14).

### D12: A chat reply compacts a long context, after one silent memory turn

pi 1.6 compacts by itself (`compaction.enabled`, `reserveTokens`, `keepRecentTokens`) and through `session.compact()`. Its automatic path has no place for a turn of the agent's own before the cut, so operad keeps it off (D3) and decides when to call `session.compact()` itself; the summary, the cut and the session entry are pi's.

A chat reply passes `compact: { at, flush?, now?, only? }` to the `agent` step (a task passes none, so a task never compacts). The worker checks the context after the reply's turn: pi's own estimate of the session (`getContextUsage()`, else the last message's input plus cache read and write) against the model's window. At or above `at` (0.75, a constant of the chat plugin, not a setting), or when `now` or `only` says so, it first runs `flush`, one more turn of the same session whose prompt is the given text, then calls `session.compact()`. A model whose window is unknown is never compacted automatically. `now` compacts after the reply whatever the size; `only` runs no prompt at all, only the flush turn and the compaction, for a session that is resumed.

The flush turn is silent: its text and thinking are neither increments nor the reply's `finalMessage`, which stays the first turn's text, and its message line carries no text. Its tool calls go through the same hook and access profile as any turn, and its usage and price count. A flush that fails, or a compaction that fails (pi refuses a session too small to cut, or the summary call fails), is logged and never fails the reply; the result then carries no `compaction`. The flush text is given by the chat, and only a chat that has memory notes (ADR 0026 D18) gives one; a chat without it is compacted with no flush turn.

The result line carries `compaction: { reason, before, after?, flushed }` when the session was compacted, and `context` is the size after it, so the next reply does not look as if the context had just been huge. The step's data carries `compacted: true` and `compaction`. A kept worker (D10) is used the same way; the kept-worker key leaves `compact` out, because it changes per reply and not the worker. Cancel during the flush or the compaction ends the run as a cancelled one.

A compaction runs only in the run of the reply that made the context big, straight after that reply's turn and the flush turn, so it reads a prompt cache that is warm; there is no idle compaction. A `/compact` on a session that has been idle runs on a cold cache. pi's summary keeps its own `<read-files>` and `<modified-files>` lists, and a test holds that. When the context a compaction leaves is still at or over `at` of the window, the chat does not compact again in a loop: the chat plugin records that the session is full, the next reply fails with one plain line that says the chat is too full to continue and suggests `/new`, and the agent is not called. A `/new`, or a compaction that fits, ends it.

Claude's SDK keeps its own automatic compaction on (`packages/harness/claude/REFERENCE.md`), and codex's app server compacts under its own configuration, which operad does not change; radian's agent has no compaction operad sets. Nothing here is built for them.


### D13: Old tool results are pruned from what the model is sent, after the prompt cache has expired

pi puts a built-in tool's output into the model context cut, not whole: 2,000 lines or 50 KB (about 12,500 tokens), whichever comes first. The tools operad adds (`operad_*`) are not cut by pi. So the context grows by many results of up to 50 KB each, and a long chat carries the ones from hours ago.

The worker prunes them in operad's inline extension, through pi's own `context` hook. pi gives that hook a deep copy of the transcript without the system messages and sends what it returns, so the session file and what a person sees stay whole; the prompt and tool declarations are pi's and the hook cannot drop them. operad has no context hook of its own to use. Compaction (D12) is separate and unchanged.

A prune rewrites the cached prefix of the prompt, so two rules say when it is worth it:

- **Time.** Nothing is pruned while the provider's prompt cache is alive. The lifetime is the model's own `promptCache` entry for the retention tier in force (`short`, or `long` when `PI_CACHE_RETENTION=long`), else 5 minutes, the short tier of Anthropic's cache. It is measured from the last model call this process made, or, in a new process on a resumed session, from the timestamp of the session's last assistant message. (pi's cache warming, on by default, can keep a cache alive past this lifetime while a kept worker idles; the prune then pays one rewrite it could have spared.)
- **Size.** Nothing is pruned unless it frees at least 20,000 characters of tool output (about 5,000 tokens), the `clear_at_least` value Anthropic's context editing uses in its example. Gemini CLI's 30,000-token floor is larger than any single built-in result. Below it, the results stay even after the cache has expired.

When both hold, every tool result older than the last 3 assistant turns (OpenClaw's number) whose text is longer than its placeholder is replaced, in the copy the model gets, by `[<tool> result removed from the context to save space]`; its call id, tool name and error flag stay so the call still pairs with it. The worker logs `pruned <n> old tool results, <m> characters` on stderr. A run's input may override the three numbers with `prune: { cacheSecs?, keepTurns?, minChars? }`; absent, the defaults above apply, to a chat reply and a task alike. No user-visible word is added.

Only `pi` prunes. Claude's SDK and codex manage their own context.
