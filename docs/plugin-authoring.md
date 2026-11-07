# Writing a plugin

A plugin is a TypeScript module that declares what it adds: object types,
steps, flows, and optionally commands, views, actions and trigger rules. This
page builds the smallest useful one and tests it without starting `operad
serve`. The test uses only `@operad-io/engine/testing`.

## A plugin with one object, one step and one flow

```ts
import { defineFlow, definePlugin } from "@operad-io/engine";

/** Writes the note the flow was started with, then asks whether to publish it. */
const review = defineFlow({
  name: "review",
  entry: "draft",
  steps: [
    {
      id: "draft",
      kind: "plugin",
      params: { use: "notes/draft", params: {} },
      replay: "safe",
      next: { ok: "approve", failed: "rejected" },
    },
    {
      id: "approve",
      kind: "wait_person",
      params: { prompt: "Publish this note?", choices: ["publish", "discard"] },
      replay: "safe",
      next: { publish: "published", discard: "rejected", interrupted: "rejected" },
    },
    { id: "published", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "rejected", kind: "end", params: { status: "cancelled" }, replay: "safe" },
  ],
});

export default definePlugin({
  name: "notes",
  kind: "domain",
  version: "0.1.0",
  objects: [{ name: "note" }],
  steps: [
    {
      name: "draft",
      results: ["ok", "failed"],
      run: async (ctx) => {
        const object = ctx.object;
        if (object === undefined) throw new Error("the review flow needs a note to work on");
        const text =
          typeof ctx.params === "object" && ctx.params !== null && !Array.isArray(ctx.params)
            ? ctx.params.text
            : undefined;
        if (typeof text !== "string" || text.length === 0) {
          throw new Error("the review flow needs a text");
        }
        await ctx.store.put("note", object.id, { text, published: false }, "notes/draft");
        return { result: "ok" };
      },
    },
  ],
  flows: [review],
});
```

- A **step** returns one of the results it declares. Each result is an edge of
  the flow. A step that throws ends with `failed` when it declares that result
  (otherwise `interrupted`), and the message goes into the history.
- A **flow** is data: steps, and for each step where each result leads. The
  four basic steps are `plugin` (call a step), `wait_person`, `wait` (a time or
  a check) and `end`.
- `ctx.store` holds the plugin's objects. `put` writes a new version and the
  change is recorded with its cause.

Check that the declaration is valid:

```sh
operad plugin check ./notes/index.ts
```

## Testing it

`@operad-io/engine/testing` runs a flow in the test's own process with the
engine's own runner and kernel. Nothing is started, nothing is left running.

```ts
import { afterAll, expect, test } from "bun:test";
import { answer, cleanup, runFlow } from "@operad-io/engine/testing";
import notes from "./index.ts";

afterAll(cleanup);

test("a note is drafted, waits for a person and is published", async () => {
  const run = await runFlow(notes, "review", { params: { text: "hello" } });

  // The draft step ran and the flow now waits for a person.
  expect(run.status).toBe("waiting_person");
  expect((await run.store.get("note", "1"))?.data).toEqual({
    text: "hello",
    published: false,
  });
  const wait = run.wait;
  if (wait === undefined) throw new Error("expected a wait");
  expect(wait.choices).toEqual(["publish", "discard"]);

  const done = await answer(run, wait.id, "publish");
  expect(done.status).toBe("ended");
  expect(done.end).toBe("done");
});
```

### What the package gives you

| Export | What it does |
|---|---|
| `runFlow(plugin, flow, options?)` | Starts `flow` (a name or the flow value) and runs it to its end or its first wait. Options: `object`, `params`, `settings`, `secrets`, `access`, `clock`. The default object is `<first object type>:1`. |
| `answer(run, waitId, choice, note?)` | Answers the person wait the run is in and runs on to the next end or wait. A stale `waitId` or a choice the wait does not offer throws. |
| `resume(run)` | Runs a run on after something outside it changed, such as the clock passing a time wait. |
| `emit(plugin, source, type, data?, options?)` | Sends an event through the plugin's trigger rules, as a source plugin would. A rule that matches starts its flow and the run goes to its end or first wait. |
| `fakeClock(start?)` | A clock the test moves: `now()`, `advance(ms)`, `whenTimer()`. Pass it as `clock`; step timeouts and time waits follow it. |
| `memoryStore()` | An empty in-memory object store, to seed objects before a run (`options.store`). |
| `cleanup()` | Removes every scratch directory the package made. Call it in `afterAll`. |

A run is a snapshot: `status` (`"ended"`, `"waiting_person"` or `"blocked"`),
`end` (`"done"`, `"failed"` or `"cancelled"` once ended), `wait` (its id, prompt
and choices while a person is asked), `facts` (everything the run recorded, in
order), `history` (one line per step, as `operad history` prints it) and
`store` (the plugin's objects). `answer` and `resume` return a new snapshot.

### A step that fails, and a step that times out

```ts
const run = await runFlow(notes, "review");        // no text
expect(run.end).toBe("cancelled");
expect(run.history.join("\n")).toContain("the review flow needs a text");
```

A step that never settles is cut off by the step timeout. With a fake clock the
test decides when:

```ts
const clock = fakeClock();
const running = runFlow(plugin, "slow", { clock });
await clock.whenTimer();      // the step started and its timeout is set
clock.advance(5 * 60 * 1000); // the default step timeout
const run = await running;    // the step ended `interrupted`
```

### An event that starts a flow

A plugin that ships `rules` starts flows from events. `emit` sends one the way
a source plugin does:

```ts
const sent = await emit(plugin, "mail", "mail.received", { subject: "hi" });
expect(sent.started).toBe(true);
expect(sent.run?.end).toBe("done");

const ignored = await emit(plugin, "mail", "mail.other");
expect(ignored.started).toBe(false);
```

A test that needs more than this, such as several runs in one store, passes
the same `store` to each `runFlow`.
