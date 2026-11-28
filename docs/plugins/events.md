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
| `paused` | boolean | not set | `true` keeps a cron rule in the file but stops its ticks | At load | `paused: must be true or false` |

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

A plugin of kind `source` declares `start(ctx)`; `serve` calls it once and calls `stop()` of the returned handle on exit. A plugin of another kind that declares `start` is started the same way.
The context also has `repositories()`, the repositories the loaded plugins registered (their [project settings](settings.md#project-settings)), read when called, and `harnessCommand(name)`, the command line a person runs that harness's agent with (its [`interactiveCommand`](harness.md#a-command-for-a-person)), or `undefined`.
When `serve` cannot load the trigger rules it starts only the plugins that declare `startsWithoutRules`, which says their `start` sends no event.
Its context adds `rules` (the routing rules, already checked), `clock` (a `() => number` of the kernel's time), `client` and `emit(event)`, which sends `{ source?, key, type, object?, summary?, data?, link? }` through the rules with `source` defaulting to the plugin's name and `hops` 0.
`client` is the client API that HTTP and the TUI use, the same object and not a copy: `list`, `get`, `section`, `events` (the ids that changed, as they happen), `act`, `pending` (what waits for a person) and `answer` (the answer to one question of a pending item). A source plugin that shows items to people and takes their answers needs nothing more from the kernel: it watches `events`, reads `pending`, and answers with `act(name, id, { actor })` or `answer({ runId, waitId, choice, actor })`. Both need an `actor`, `{ via, id }`, naming the person and the surface they answered on (for example `{ via: "telegram", id: "<user id>" }`); a call without one is refused (`action "<name>" needs an actor: { via, id } says who asked`, or `answer needs an actor: { via, id } says who answered`), and history names that actor. The action's own rules still decide who may do what, and a second answer to an item that was answered is refused the way it is for any client. The settings calls of the full client are not part of this API.
## A running plugin's routes and events

The handle `start` returns may carry `http`, a `PluginHttp`, which `operad serve` serves behind its token:

- `request({ method, path, local, body })` answers a request under `/v1/<plugin name>`: `path` is the decoded segments after the name, `body()` reads the JSON body once, and the answer is `{ status, body }`, or `undefined` for no such endpoint. A built-in endpoint is never handed to a plugin.
- `stream({ values, local })` is called for a `GET /v1/events` whose query names the plugin, with that parameter's values. It returns `{ open(send) }`, and `send({ name, data })` writes the event `<plugin>.<name>`; the function `open` returns is called when the stream closes. It may return `{ status, body }` instead, which refuses the whole request. Plugin events have no id and are not replayed. A stream that holds more than `MAX_PLUGIN_STREAM_BYTES` of them unread is closed. An event sent with `snapshot: true`, what a reader is given once when it joins, may be of any size and is not counted.

`serve` answers HTTP before the plugins have started, and one plugin starts at a time, so write `stream` to be called at any time while the plugin runs:

- A request under `/v1/<plugin name>` for a plugin that is about to start, or has been stopped, is answered `503` with the error kind `unavailable` and a `Retry-After` header; `request` is not called. A plugin that waits for `serve` to install its package is about to start. One that failed to start, whose install failed, or that is not started because the trigger rules could not be loaded is not, and its routes are `404`.
- A stream that names a plugin which is not running is answered at once. When the plugin starts, the stream gets a `reset`, so the client reads again what it asked for too early, and then `stream` is called and its part is opened. A refusal at this point has no status left to answer with: the stream ends, and the client's next stream gets the refusal. A `stream` or `open` that throws here also ends the stream.
- When the plugin is stopped, its part is closed (the function `open` returned is called) after `stop()`, so what the plugin sends while it stops still arrives. The stream stays open, and the next start joins it again in the same way.

A program that runs the kernel and its HTTP server itself learns of each start and stop from a `SourceWatcher`, `(plugin, running) => void`, which it registers with `kernel.watchPlugins(watcher)`; the function that returns ends the watch.

`local` is true only for a request that came over loopback from this machine, to a loopback host name, with no forwarding header (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `X-Client-IP`, `True-Client-IP`, `Fastly-Client-IP`, `X-Envoy-External-Address`, `CF-*` or `Tailscale-*`). A route that must not be reached from elsewhere checks it.

| Export | What it is |
|---|---|
| `isLocalRequest(peer, request)` | The test behind `local`, from the peer's address and the request |
| `MAX_PLUGIN_STREAM_BYTES` | 32 MiB: how much unread plugin event data one stream holds |

A `start` that throws is logged and skipped, so one broken source does not stop the others. An `emit` that fails is logged as `emit failed: <message>`.
`source-cron` is a source that sends a `tick` event for each rule schedule that is due; `parseCron(text)`, `cronMatches`, `cronMinutesBetween`, `latestCronMinute` and `minuteStart` are the helpers it uses and `CronError` is what a bad expression throws.

## Testing events

`emit(plugin, source, type, data?, options?)` and `testWorld(plugin).emit` of [`@operad-io/engine/testing`](testing.md) send an event through the plugin's rules and report whether it started a run.

## Notifications

A notification is not an event: it is the `notify` command `serve` runs when a flow wait opens. See [Pending items](pending.md#notifications-and-channels).
