---
description: Pending items and person waits: choices, answers, standing items, automatic answers and confirmation.
---

# Pending items and person waits

*Pending* is the list of things waiting for a person. Four kinds of item are in it, and a plugin makes two of them:

| Kind (`kind`) | Made by | What it is | How it is answered |
|---|---|---|---|
| `run` | A flow's `wait_person` step, or a step's [`ctx.ask`](asking.md) | A run is waiting for a choice. `prompt` and `choices` come from the wait; `waitId` names the question | An answer with one of the `choices` |
| `standing` | A plugin's `standing` hook | Something a person should look at that waits on no run | Its `actions`, or by fixing the cause: the item goes away when the hook stops returning it |
| `candidate` | A trigger rule with `mode: "candidate"` | An event that would start a flow; its prompt is `would start <flow> on <object>` | The kernel actions `operad:start` and `operad:dismiss` |
| `refused` | The kernel | An event routed to a flow that cannot start yet, with the reason as the prompt | Fix the cause; the item has no actions |

Each item carries `runId` (a run id, a candidate's pending id, or `<plugin>:<id>` for a standing item), `flow`, `step`, `prompt`, `choices`, the `actions` that hold for its object (each `{ plugin, action }`, ranked), and when the item is about an object: `object` (`<type>:<id>`), `link` and the object's `row`.

## A wait for a person in a flow

```ts
{
  id: "approve",
  kind: "wait_person",
  params: { prompt: "Publish this note?", choices: ["publish", "discard"] },
  replay: "safe",
  next: { publish: "published", discard: "rejected", interrupted: "rejected" },
}
```

| Param | Meaning |
|---|---|
| `prompt` | What the person reads. Non-empty. |
| `choices` | The answers offered, as plain strings. Each choice is a result of the step and needs an edge in `next`; `interrupted` always needs one. A choice is both what the person picks and the name of the edge: there is no separate display label. |
| `lateChoices` | Answers a timed-out step may hand over that this wait does not offer by itself. |
| `note` | Shown when the step that led here was interrupted; `{step}` names that step. |

The wait is identified by `<step id>:<visit>` (the second time the run reaches `approve` is `approve:2`); that is the `waitId` an answer quotes, and a run that waits at the same step again is a new wait.
Nothing in a process holds the wait: it survives a restart.

An answer records `{ waitId, choice, note?, actor }`. A choice the wait does not offer is refused with `run <id>: "<choice>" is not one of "publish", "discard"`; an answer to a run that is not waiting, with `run <id> is not waiting for a person`; an answer that names a question that is not the open one, with `run <id>: no question "<waitId>"`.
A note is free text a person adds to an answer. A step that asked with `ctx.ask` gets it back as `note`, and a harness step that runs again after the answer gets it in `askAnswer.note`.

## Confirmation

An *action* that can do harm sets `confirm: true`: the person must confirm before it runs (`--yes` on the command line, `"confirmed": true` in an HTTP body, a prompt in a client). A refused call says `action "<a>" needs confirmation; pass --yes`. See [Actions](actions.md#the-fields).
A *setting* whose change needs confirmation sets `confirm: true` in its schema: see [Settings](settings.md#editing-a-setting).
A *flow* asks a person with `wait_person`: a confirmation inside a flow is a wait with the choices a person picks between.

## Standing items

```ts
standing: async (ctx) => {
  const page = await ctx.store.list("note", { where: { state: "stuck" } });
  return page.objects.map((object) => ({
    id: `stuck:${object.id}`,
    prompt: `${object.id} is stuck`,
    object: { type: "note", id: object.id },
  }));
},
```

| Field of a `StandingItem` | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | Names the item within its plugin; the same id is the same item |
| `prompt` | string | required | What the person reads |
| `object` | `{ type, id }` | not set | The object the item is about. The item then carries the actions whose `when` holds for it and the object's row. An item whose object is gone says nothing and is left out |
| `announce` | boolean | `true` | `false` keeps a channel from announcing the item; it is still pending |
| `covers` | list of `{ type, id }` | not set | Other objects the item stands for, such as the proposed tasks of a draft plan |

The hook runs each time the pending view is built and returns the items that hold now, so an item disappears when it is fixed. A throw is logged (`plugin "<name>": standing failed: <message>`) and that plugin adds no items to that view. The hook gets the [base context](define-plugin.md#the-context-every-hook-gets) and `loaded`, the names of the loaded plugins.

## Waits a plugin answers itself

An object type's `answeredAutomatically(data, { store })` says that the plugin will answer the object's wait. While it returns `true` the wait is not a person's to answer: it is left out of pending (unless the caller asks for automatic ones too, in which case the item carries `auto: true`) and no notification is sent for it. A wait whose automatic answer is refused, or whose auto level changes, stops being marked the next time the view is built. A hook that throws means `false`: the person is told.

## Notifications and channels

When a flow wait opens, `serve` runs the command `notify.command` in `config.json` names, once per wait; see [Notifications](../user/notifications.md) for the keys and the environment the command gets.
The notification is recorded as a global fact `notified` with the key `notify:<runId>:<waitId>` after the command ended, so a restart of `serve` while the same wait is open does not send it again, and a crash between the command and the record sends at most one extra.
A command that fails or times out (30 seconds, `NOTIFY_TIMEOUT_MS`) is recorded as failed and is not retried.
Only waits of flows (`wait_person`) notify. A step's own `ctx.ask` question and a standing item are in pending but do not run the command.
