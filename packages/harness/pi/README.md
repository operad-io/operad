# @operad-io/harness-pi

The pi harness. `src/worker.ts` is the child program: it imports the library of the pi you installed (see "Installing pi"),
reads one JSON object from stdin, runs one prompt and writes one JSON object per
line to stdout. The last line is the `Result`. The hub-side step
(`src/index.ts`, described under "The plugin" below) spawns it. Decisions: `docs/backlog/operad-harness-pi.md` 2, 3, 5, 6, 7.

Run it as `bun packages/harness/pi/src/worker.ts`. stderr is free text for
humans and is never parsed.

pi does no discovery here: the only extension is operad's inline one, settings
are in memory, and every path pi uses comes from the input (`agentDir`,
`sessionDir`, `authPath`, `modelsPath`). Nothing under the user's `~/.pi` is
read unless the input names it.

## Installing pi

operad does not bundle pi. Install it yourself, with bun
(`bun add -g @earendil-works/pi-coding-agent`) or npm
(`npm i -g @earendil-works/pi-coding-agent`), so that a `pi` command is on
`PATH`. The worker resolves the real path of that command, walks up to the
directory whose `package.json` is `@earendil-works/pi-coding-agent`, and imports
the file its `exports["."]` names. It logs `pi <version> loaded from <dir>` on
stderr. The oldest version it accepts (the floor) is `1.5.0`; a prerelease of
`1.5.0` is below it. `operad plugin check` reads the same `package.json` and
fails, naming both versions, when pi is older than the floor, and fails when
there is no `pi`. The `@earendil-works/pi-coding-agent` in this package's
`devDependencies` serves the tests only.

`pi` must lead into the package through symbolic links, as the bun and npm
installs make it. A shell wrapper script is refused with its path; set the
`command` setting to the package's bin (for example
`~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`)
to use another pi or a wrapper's target.

## stdin

One JSON object, then EOF. `test/protocol.test.ts` checks the program against
this table.

| field | type | required | meaning |
|---|---|---|---|
| `prompt` | string, non-empty | yes | the text sent to the model |
| `cwd` | string, non-empty | yes | working directory of the agent |
| `authPath` | string, non-empty | yes | pi's credentials file |
| `modelsPath` | string, non-empty | yes | pi's custom models file |
| `agentDir` | string, non-empty | yes | pi's agent directory (empty of user config) |
| `piCommand` | string, non-empty | no | the pi command, a name on PATH or a path; absent means `pi` |
| `sessionDir` | string, non-empty | yes | directory for session files |
| `resumeSession` | string, non-empty | no | session file path from an earlier `Result.sessionId`; the prompt is sent into it |
| `model` | string `provider/id` | no | model to use; absent means pi's own default |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | no | reasoning level; absent means pi's default |
| `access` | object | no | the access profile; `denyPaths` and `denyCommands` (arrays of strings) are enforced in the `tool_call` hook by `@operad-io/access-match`, other fields are ignored; absent means nothing is denied |

An invalid object (not JSON, not an object, a required field missing or of the
wrong type, an optional field of the wrong type) writes one `Result` line with
`result: "failed"` and `message` naming the field, and exits 2.

## stdout

One JSON object per line, flushed per line, each with a `type`. Only these
types appear, in the order the run produces them:

| type | other fields | meaning |
|---|---|---|
| `message_end` | `role` (`"assistant"`), `text` (optional: the first 300 characters of the message's text as one paragraph; thinking and tool calls left out), `stopReason` (string), `usage` (`{input, output, cache_read, cache_write}`, numbers), `cost` (`{total}` in USD, or `null` when pi gave no price) | an assistant message finished; only assistant messages are written |
| `tool_execution_start` | `toolCallId`, `toolName`, `at`, `input` (optional) | a tool call began. `at` is the start time in epoch milliseconds. `input` says what ran: for `Bash` the command (one line, first 500 characters), for `Read`, `Edit` and `Write` the path, for another tool its main argument (path, pattern, query, URL or description) when it has one; absent otherwise. Never file contents or tool output. A command shows the values of leading environment assignments (`NAME=value`) as `NAME=***`, masks any value of the operad secret store or of a secret-named environment variable (`KEY`, `TOKEN`, `SECRET`, `PASS`, `PASSWORD`, `AUTH`, `CREDENTIAL`; 6 characters or more) as `***`, and shows `<command not shown: could not read it safely>` for a command it cannot read (an open quote, or a command or process substitution, heredoc or arithmetic in a leading assignment). A call the access profile denies shows `<tool> denied by the access profile`, never its arguments |
| `tool_execution_end` | `toolCallId`, `toolName`, `isError`, `durationMs`, `error` (optional) | a tool call ended. `durationMs` is how long the call took, measured from its start line. `error` is the first line of the error (at most 300 characters) when `isError` is true; the rest of the error stays out of this line. A refused call writes no `tool_output` |
| `tool_output` | `toolCallId`, `text`, `truncated` (optional `true`) | what a tool call printed, as text cut to 64 KiB of UTF-8; `truncated` is true when it was cut. Written before the call's `tool_execution_end` |
| `text_delta` | `text` | new assistant text only, not the text so far; at most one line per 100 ms, the rest grouped |
| `thinking_delta` | `text` | new thinking only, not the thinking so far; at most one line per 100 ms, the rest grouped |
| `text_end` | `text` | the full text of a finished assistant message, after its increments |
| `thinking_end` | `text` | the full text of a finished thinking block, after its increments |
| `blocked` | `toolName`, `reason` | the access matcher refused a tool call; the call does not run: its `tool_execution_end` has `isError: true` and the model gets `reason` as the tool result. The run continues |
| `agent_settled` | `aborted` (boolean) | pi has stopped for good (not `agent_end`, after which pi may continue) |
| `result` | see below | always the last line |

Every `text_delta`, `thinking_delta`, `text_end`, `thinking_end` and
`tool_output` line replaces each value of `secretValues` with `***`, as the
tool call input does. An increment that would end inside a secret value, or
inside its JSON-escaped spelling, holds the rest of it back for the next
increment, so a receiver that joins the increments never sees the value whole;
when the run stops, what is still held is written before the Result.

### Result

| field | type | required | meaning |
|---|---|---|---|
| `type` | `"result"` | yes | |
| `result` | `"done"`, `"failed"` or `"cancelled"` | yes | how the run ended |
| `sessionId` | string or null | yes | the session file path; null when no session was opened |
| `usage` | `{input?, output?, cache_read?, cache_write?}` | yes | sums over every `message_end` (`cacheRead` becomes `cache_read`, `cacheWrite` becomes `cache_write`) |
| `cost` | `{micros}` or null | yes | `round(sum of cost.total × 1e6)`; null when any `message_end` had no price, or there was none |
| `finalMessage` | string or null | yes | `getLastAssistantText()` |
| `reason` | string | on `failed` | a short condition name: `invalid_input`, `session_missing`, `model_missing`, `model_error` (also used for an unexpected error) |
| `message` | string | on `failed` | human text; names the field or path at fault |

## Exit codes

| code | when |
|---|---|
| 0 | `done` |
| 1 | `failed` after the input was valid |
| 2 | invalid input |
| 143 | SIGTERM: the program calls `abort()`, waits for idle, writes a `cancelled` Result and exits |

## Resume

With `resumeSession` the program opens that file with `SessionManager.open`
and sends the new prompt into it. A file that does not exist is `failed` with
the path in `message`. `sessionId` of the new Result is the same path.

## Tests

`test/fake-worker.ts` runs the same program with a fake model registered
(`test/fake-provider.ts`); the script comes from the `FAKE_SCRIPT` environment
variable. It exists because a model cannot travel over the stdin protocol.

## The plugin

`src/index.ts` is the hub side: the plugin `pi`, its step
`pi/agent` and its flow `pi:prompt`. It never imports pi (it only reads its version in `check`); it
starts `bun src/worker.ts` through `runAgent` from `@operad-io/harness-process`,
writes the stdin object above, appends every stdout line to the step's log with
`JsonlLog`, and turns the last `result` line into the facts.

The plugin is not installed by `operad init`. Turn it on with:

```sh
operad plugin enable pi
```

A flow switches harness by changing `use` from `radian/agent` to
`pi/agent`; `dev` does it with `worker.use` in `.operad/dev.json`. The
params, the result names (`done`, `failed`, `interrupted`) and the facts
(`exitCode`, `signal`, `sessionId`, `finalMessage`, `usage`, `log`,
`durationMs`, `stderr`) are `radian`'s, except `args` (below). `usage`
is the standard one described in [the manual](../../../docs/user/dev.md#usage-and-end-results):
`model` is the step's `--model` or the `model` setting, and the worker's
`cost.micros` becomes `costMicros`.
`sessionId` is the path of pi's
session file; pass it back as `resumeSession` to continue it.

### Params: `args`

pi takes no command-line arguments, so the step reads two flags from `args`, in
the spelling `radian` passes to radian. This lets `dev` run the worker
and the reviewer on different models through the same plugin.

| flag | value | meaning |
|---|---|---|
| `--model` | `provider/id` | the model for this step |
| `--thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | the reasoning level for this step |

A flag in `args` wins over the setting of the same meaning (`model`,
`thinkingLevel`); a chat passes its effort as the step param `effort`, which is
its thinking level and also wins over the setting; without either the setting
applies; without all, pi's own default applies and the field is not sent to the
worker.

Any other entry fails the step at once, before the worker starts, with result
`failed`, reason `invalid_args` and a message that names the entry: an unknown
flag, a flag without its value, a model that is not `provider/id`, an unknown
level, a flag given twice. Ignoring a flag silently would hide a wrong model.

### Settings

The `pi` section of `config.json`. The kernel fills the defaults. A step
param (`wallTimeSecs`, `stallSecs`) overrides the setting of the same name.

| setting | type | default | meaning |
|---|---|---|---|
| `model` | string `provider/id` | unset | the model; unset uses pi's own default model |
| `models` | list of `provider/id` | unset | the models a chat may pick; unset offers every model `pi --list-models` prints |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | unset | the reasoning level; unset uses pi's default |
| `command` | string | `pi` | the pi command: a name on PATH or a path; it must lead into an installed `@earendil-works/pi-coding-agent` at the floor version or newer |
| `authPath` | string | `~/.pi/agent/auth.json` | pi's credentials file; the plugin passes the path and never reads the file |
| `modelsPath` | string | `~/.pi/agent/models.json` | pi's custom models file |
| `wallTimeSecs` | number | `3600` | the longest one run may take; at most 28500 |
| `stallSecs` | number | `600` | how long a run may print nothing while no tool call is open |
| `bashTimeoutSecs` | integer, 1 or more | `1800` | the longest one bash call may run, in seconds; it is the default and the maximum for a call. A call that reaches it is stopped and the model gets a tool error; the run goes on |
| `operadTools` | object `{ home }` | absent | operad's own tools: the worker opens the home with `@operad-io/mcp` and registers each tool as a pi custom tool named `operad_<tool>` (`operad_list`, `operad_act`, …), with the server's own JSON Schema. A refusal is a tool error and the run goes on. The access profile does not judge them; the owner's MCP allow lists do |
| `images` | array of `{ path, mediaType }` | absent | image files (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) given to `session.prompt` as image input beside the prompt text |
| `concurrency` | object, model to positive integer | `{}` | how many runs of one model may go at once, such as `{ "opencode-go/deepseek-v4.1-flash": 2 }`; a model not listed has no limit |

How `concurrency` limits runs, what the key is and how a queued step shows
are in [the manual](../../../docs/user/dev.md#limiting-runs-of-one-model).

A leading `~` in a path is the user's home directory. The step's own timeout is
eight hours, above every allowed wall time.

### Where files go

pi runs with an agent directory of its own, `<operad home>/harness/pi`, empty of
user configuration. Session files are in `<operad home>/harness/pi/sessions`
(`~/.operad/harness/pi/sessions` by default), so the user's own `pi` command
does not see them. The step's log, one JSON line per worker line, is in the
store like every step log.

### How the step ends

| condition | result | `reason` |
|---|---|---|
| worker `result` is `done` | `done` | |
| worker `result` is `failed` | `failed` | the worker's own reason |
| worker `result` is `cancelled`, or the run was cancelled | `interrupted` | `cancelled` |
| no `result` line, the worker was killed by a signal | `interrupted` | `signal` |
| no `result` line, the worker exited | `failed` | `no_result`; `message` ends with the worker's last five stderr lines |
| wall time, stall, a line over 8 MiB, no program, no directory | `failed` | `wall`, `stall`, `line_too_long`, `missing` or `spawn`, `cwd` |

A stall is silence while no tool call is open: pi's `tool_execution_start` opens
one and `tool_execution_end` closes it. The wall time always applies.

An open tool call is therefore not a stall by design; `bashTimeoutSecs` is what bounds one bash call. The worker enforces it by setting the `timeout` of every bash tool call in its `tool_call` handler (pi's bash tool takes a `timeout` in seconds and has no default). The worker also drops `BASH_ENV` and `ENV` from its environment; pi runs `bash -c`, so the user's aliases and functions do not apply.

### Model errors

A worker failure with reason `model_error` also sets `data.modelError`, the
shape `radian` gives: `{ kind, status, retry_after_secs, message }`.
`kind` is derived from the error text the worker passes on: a usage limit
(`usage limit`, `quota`, `out of credits`) is `usage_limit`; otherwise a 429, 503
or 529, `overloaded`, `rate limit` or `too many requests` is `unavailable`; any
other text is `protocol`. `status` is that number when the text has one, else
`null`; `retry_after_secs` is `null` because pi does not report it. `dev`'s
review and work waits read `kind` and so treat both harnesses alike.

### Asking and resuming

The step is `resumable: true`. When the flow returns to it after a question was
answered, its params carry `resumeSession` and `askAnswer`; the step passes
`resumeSession` to the worker and adds `You asked: <prompt>. The answer is:
<answer>. Continue.` to the prompt.

A one-time permission arrives in the profile as `grants: [{ waitId, kind,
value }]`. When it is present the step keeps the worker's stdin open after the
input line. A `tool_call` the profile refuses and that equals a grant exactly
(`bash` command text, or a path tool's path) makes the worker write
`{"type":"grant_use","id":n,"waitId":"..."}` to stdout and wait for one stdin line
`{"type":"grant_ack","id":n,"used":true|false}`. The host records `grant_used`
before it answers `used: true`; only then does the call run. A second identical
call finds the grant used and is checked against the profile as usual.


### Asking about a call

A call the profile's `askCommands` matches (and that no deny rule matched: deny
wins over ask) asks a person instead of running. The step keeps the worker's
stdin open. The worker writes `{"type":"ask_call","id":n,"kind":"command","value":"<the whole command>","shown":"...","session":"<session>"|null}`
and holds the call; the host asks with `ctx.ask` (choices `allow_once`,
`allow_always` and `reject_once`, the grace period of the kernel: 10 minutes by
default, set by `ask.graceSecs`, `askGraceSecs` of the step or the question) and
answers on
stdin `{"type":"ask_ack","id":n,"decision":"allow"|"deny"|"stop","reason"?}`,
after which the worker writes `{"type":"ask_resolved","id":n}`. Questions go
one at a time. A command that holds a value of the operad secret store is
refused and never asked about, so no fact holds a secret.

- Answered within the grace period (`allow`): the same step goes on and this one
  call runs. `allow_once` keeps nothing for another call; `allow_always` also
  appends the exact command or tool, path and working directory to
  `$OPERAD_HOME/access-user.json`, so later runs read it from the profile's
  `alwaysAllow` entries. `reject_once` is `deny`.
- Not answered in time (`stop`): the worker holds the call, the host ends the
  program, and the step ends `waiting` (the result is declared). The one pending
  item stays, with the run's object. The flow's `waiting` route goes to a wait
  for a person and back to the step.
- Answered later: the step runs again with `resumeSession`, `askAnswer` and
  `grants: [{ waitId, kind, value }]` for `allow_once` or `allow_always`. The
  worker uses the grant for the one call it covers (`grant_use`, above); an
  `allow_always` answer also writes its entry to the user layer first. Any other
  call asks again. After `reject_once` no grant arrives and the model is told so
  in the prompt.
- A run no person's message started (a schedule, a webhook or another event)
  neither reads the user layer nor offers `allow_always` (`operad-sandbox.md`
  decision 8).

The host's half (`createCallAsker`, `askCall`, `askRequest`) is in
`@operad-io/harness-process`. `askCommands` is in the step's `enforces`.

### Access profile

The step declares `enforces: ["denyPaths", "denyCommands", "askCommands"]` and
passes the run's profile to the worker, whose `tool_call` handler applies it.
