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
