---
description: Events and notifications: rules that start flows, events from steps, actions and sources, keys, hops and the errors.
---

# Events

An event is a fact that something happened: a mail arrived, a run ended, a person asked for a flow. The kernel stores every event and *rules* decide which flow, if any, each one starts.
A plugin takes part in three ways: it ships default rules, it sends events (a step, an action or a source plugin), and it declares the flows the rules start.

## The event

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Who sent it. A source plugin's name, a client such as `ios`, `cron`, or `operad` for the kernel and for a step |
| `type` | string | What happened, such as `mail.received` or `run.done` |
| `key` | string | Makes a repeat of the same event a no-op: the same source and key is recorded once |
| `object` | string | The object it is about, as `<type>:<id>` |
| `summary` | string | One line for people |
| `data` | JSON | External material. It is written to a file and **never put into a prompt**; a step sees the file's path |
| `link` | string | A link the event came with |
| `hops` | number | How deep the chain is: events from outside are `0`; an event a run emits is the starting event's `hops + 1` |

An event deeper than `MAX_TRIGGER_HOPS` (8) is recorded and starts nothing: a skip is recorded with the reason `the chain is <n> hops deep; at most 8 are followed`.
The kernel sends `run.done`, `run.failed` and `run.cancelled` (source `operad`, key the run id, object the run's object) when a run ends, so a rule can chain flows.

## Rules

A rule maps an event to a flow. A plugin ships defaults in `rules`; the person's `triggers.json` replaces every plugin rule of the same `source` and `type`.
See [`triggers.json`](../user/config.md#triggersjson) for how a person writes them.

| Field | Type | Default | Allowed values | When it takes effect | A wrong value |
|---|---|---|---|---|---|
| `source` | string | required | Non-empty | At load | `<file>: rule <i>: source: must be a non-empty string` |
| `type` | string | required | Non-empty | At load | `type: must be a non-empty string` |
| `start` | object | required | `{ flow, params? }`: a loaded flow and fixed JSON params (a nested value that is not JSON, a cycle or a hole is refused) | At load | `start: must be an object`; `start.flow: unknown flow "<f>"` |
| `object` | string | required | A fixed object key `<type>:<id>`, or `$event.object` to use the event's | At load | `object: must be a non-empty string` |
| `mode` | string | required | `observe`: record only; `candidate`: put a pending item a person starts or dismisses; `auto`: start the flow | At load | `mode: must be "observe", "candidate", "auto"` |
| `schedule` | string | not set | A five-field cron expression in the machine's local time zone, evaluated for a source that ticks (`source-cron`) | At load | `schedule: <the cron message>` |

An unknown key in a rule is `<key>: not a rule field`. Rules from a plugin are checked by the same validator as the file and with the plugin's name in the message.
The result of an event is one of: started, an active run was reused (`active`), recorded, observed, candidate, or skipped with a reason.

## A step sends an event

```ts
await ctx.emit({ type: "notes.published", key: "p1", object: "note:1", summary: "published" });
```

`emit` takes `{ type, key, object?, summary?, data? }`.
The type must begin with the plugin's name and a dot: `step "<use>": emit: type "<t>" must begin with "<plugin>."`.
The kernel adds `source: "operad"`, scopes the key to the run (`<runId>:<key>`, so the same key in two runs is two events), uses the run's object when `object` is left out, and sets `hops`.
Without a destination (a test that gave none): `emit: no event destination is configured`.

## An action sends an event

An action's `ctx.emit({ source, type, key, object?, summary?, data? })` is an event from a person's client. `source` is the client, such as `ios`; it may not be `operad` or empty: `plugin "<name>": emit: source must be a name other than "operad"`.

## A source plugin

A plugin of kind `source` declares `start(ctx)`; `serve` calls it once and calls `stop()` of the returned handle on exit.
Its context adds `rules` (the routing rules, already checked), `clock` (a `() => number` of the kernel's time) and `emit(event)`, which sends `{ source?, key, type, object?, summary?, data?, link? }` through the rules with `source` defaulting to the plugin's name and `hops` 0.
A `start` that throws is logged and skipped, so one broken source does not stop the others. An `emit` that fails is logged as `emit failed: <message>`.
`source-cron` is a source that sends a `tick` event for each rule schedule that is due; `parseCron(text)`, `cronMatches`, `cronMinutesBetween`, `latestCronMinute` and `minuteStart` are the helpers it uses and `CronError` is what a bad expression throws.

## Testing events

`emit(plugin, source, type, data?, options?)` and `testWorld(plugin).emit` of [`@operad-io/engine/testing`](testing.md) send an event through the plugin's rules and report whether it started a run.

## Notifications

A notification is not an event: it is the `notify` command `serve` runs when a flow wait opens. See [Pending items](pending.md#notifications-and-channels).
