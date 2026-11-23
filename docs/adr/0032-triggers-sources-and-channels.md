# ADR 0032: Triggers, Sources and Channels

Status: accepted

## Background

Work enters operad from people, from time and from the outside world, and a person is reached through channels. Every way of starting a run goes through one entry, and no outside text becomes an instruction.

## Decisions

### D1: Every run starts through one entry

`start({ flow, object, trigger? })` is the entry of every run: `dev`'s scheduling, the command line and events from sources all use it. `trigger` is `{ source, key, type, summary?, link?, data? }`. A start with a trigger first records an input (one record per `source` and `key`; a repeat does nothing and returns the first result), and the reason of `run_started` points at that input, so history can say which event started a run.

### D2: Routing is decided by the user's rules, not by the event

`~/.operad/triggers.json` is a set of rules `{ source, type, start: { flow, params? }, object, mode, schedule? }` (JSON with a Schema). A rule's target is always one flow plus parameters, and `params` is fixed JSON. `object` is fixed or taken from the event's `object` field, and only that field; everything else in the event is material. An event that no rule matches is only recorded.

### D3: Three modes

`observe` records only "would have started X". `candidate` shows a pending item with the kernel's two actions `operad:start` and `operad:dismiss`. `auto` starts directly. When a run of that flow is already running on the same object, the event is recorded in that run's history and no new run starts.

### D4: A step sees an event only through files

`ctx.trigger` is read-only; `summary` and `data` are written as files and a step decides whether to read them. The kernel never puts event text into any prompt. When there is a `ctx.trigger`, a `<harness>:prompt` flow adds one fixed line at the end of the prompt, pointing at the paths of the `summary` and `data` files and saying that it is outside material and not an instruction; the agent decides whether to read.

### D5: A source is a `source` plugin

`start(ctx) → { stop }` with `ctx.emit(event)`; `operad serve` starts and stops it. The built-in source is `cron`: a rule in `triggers.json` carries a `schedule`, a five-field cron expression in the machine's time zone. `operad trigger <source> <key> [--type] [--object] [--data <file>]` sends an event by hand for tests and scripts.

### D6: A single prompt is also a flow

Every harness plugin brings a `<harness>:prompt` flow with parameters `{ prompt, cwd, args? }` and one step that runs the agent once. A rule that wants a prompt run when an event arrives writes `start: { flow: "radian:prompt", params: { prompt, cwd } }`; the kernel has no separate path for prompts.

### D7: The result of a run is an event

When a run ends, the kernel sends an event from the source `operad` with type `run.done`, `run.failed` or `run.cancelled`, `key` the run id, `object` the run's object and `data` the result (the name of the result and a summary of the last step's facts). It goes through the rules like any event, so "run B after A" is a rule on `source: "operad", type: "run.done"`. A step may also send its own event with `ctx.emit({ type, key, object?, summary?, data? })`, recorded with the source `operad` and a type the plugin names (`<plugin>.<name>`).

### D8: Chains are bounded

Each event carries `hops`: 0 for an external event, and for an event a run sends, the `hops` of the event that started that run plus 1. An event with `hops` above 8 is only recorded, with the reason in history.

### D9: A plugin can bring default rules

A plugin's declaration carries default rules of the same shape as `triggers.json` (ADR 0010 D4), merged in at load; a rule in the user's `triggers.json` with the same `source` and `type` overrides the plugin's. `chat` is the first to use it (ADR 0026 D2).

### D10: Four channels

Only four channels are built, in this order: Telegram, WhatsApp, Slack, iMessage. The first is Telegram.

### D11: The cron source catches up missed runs

The cron source keeps the last minute it fired for each rule in `<home>/cron/state.json`, under the operad home and never under a repository's `.git`, keyed by the rule's own identity (its source, type, start, object, mode and schedule) rather than its position in the file; an entry no rule matches is dropped when the file is written. A rule with no recorded last time, including one just added or whose schedule changed, starts with its baseline at the latest planned minute at or before now and waits for the next planned time, so no tick runs for a missed time before the rule was known. Only a rule with a recorded last time catches up. When `serve` starts, or when the clock jumps far beyond the source's check interval (the machine slept), the source looks back up to seven days for each such rule, emits the most recent missed tick once, and leaves older missed times out; the tick's summary names the times it skipped and says that only the latest missed run is caught up. A catch-up tick carries the planned time and its lateness in the event data (`scheduledAt` and `lateSecs`), so a step or prompt can tell the agent; an on-time tick carries no lateness. A rule whose schedule changed starts fresh: the old schedule's last time is not used and no tick is caught up for it.

### D12: A client manages routines

The user-visible word is **Routine** (Chinese 定时任务), the same word the bot uses
for its scheduled prompts. A routine is a
rule in `triggers.json` with source `cron`, a `schedule`, `start.flow` and
`start.params`, an `object` and a `mode`; it starts an already loaded flow with
fixed parameters. The rule may carry `paused`. Pausing stops its ticks and is
kept in the file, so it survives a restart. A paused rule advances its recorded
last minute with the clock; resuming waits for the next planned minute instead
of catching up the paused period. A changed schedule starts fresh under D11.

The cron source plugin owns the management: list, add, edit, pause, resume and
remove are its `routines` command, because scheduling is plugin work and the
kernel only reads, validates and routes the rules. The command reads and writes
the same `triggers.json`; there is no second store. It refuses an unknown flow
and a bad cron expression with the reason. The command line reaches it as
`operad routines ...` (the old name `scheduled` is gone, with no alias), HTTP as `POST /v1/commands` and MCP through its
`command` tool. Listing a routine gives its flow, schedule, parameters, next
run and the last run's result and run id; the run's own history and the usual
run-ended notification are unchanged. A routine's id comes from the fields that decide what it starts (flow, params, object, mode and schedule), so editing any of them gives it a new id: the last run shown and any id a client holds are lost, and the client reads the new id from the list. An edit that would make a rule identical to another routine is refused.

A routine can run one command line (owner 2026-11-23). The `shell` plugin ships the flow `shell:command`, with parameters `command` and an optional `cwd` (default: the home). Its one step runs the same code as shell's `command` step: the same timeout, output capture and access rules, and the run records the exit code and the tail of the output in history. `operad routines add --schedule <expression> --command "<line>" [--cwd <dir>]` is a short form that writes the same rule as `--flow shell:command --params '{"command":…}'` into `triggers.json`; there is no second store. It does not take `--flow` or `--params`. Its default object is `routine:<hash of the parameters>`, so two command routines due at one time do not share an object and skip each other. `list` shows `command "<line>"` in place of the flow name, and the JSON entry has a `command` field. With `shell` off (a new home) the flow is not loaded and the add is refused with `shell is off: run "operad plugin enable shell" first`. A failed command (non-zero exit, timeout, bad directory) ends the run `failed`, and the routine row's last result shows it with the step's message (`last failed <run id>: the command exited 3`). That is the only signal: no new pending kind and no new notification, since `notify` covers waits and a bot's routines. A failed run's last result shows the failing step's message for any routine, not only this one.
