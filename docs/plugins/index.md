# Writing a plugin

This page is for plugin authors; a person who uses operad starts at [the user manual](../user/index.md). A step that asks a person a question is in [Asking a person from a step](asking.md).

A plugin is a TypeScript module that declares what it adds: object types,
steps, flows, and optionally commands, views, actions and trigger rules. This
page builds the smallest useful one and tests it without starting `operad
serve`. The tests use only `@operad-io/engine/testing`.

Where the package comes from: `@operad-io/engine` is private for now and its
exports are plain `.ts` files, so there is no npm install. Inside this
workspace a plugin imports it by name. A plugin in another repository links the
workspace package, for example with `"@operad-io/engine": "file:../operad/packages/engine"`
in its `package.json`; Bun runs the `.ts` exports as they are.

## A plugin with one object, one step and one flow

```ts
// example-plugin/index.ts
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
operad plugin check ./example-plugin/index.ts
```

## Testing it

`@operad-io/engine/testing` runs a flow with the engine's own runner and
kernel, driven by the same pass `serve` makes: an answer is recorded and then
applied, a run that ends can start the next one through the rules, and a step
runs in a worker thread that loads the plugin's module afresh. Nothing is
started that outlives the test.

Give the plugin as the path of its module. That is what lets the steps run in a
worker, so a step that keeps state in a module variable, or returns something
that cannot cross to a worker, behaves in the test as it does under `serve`.

```ts
// example-plugin/plugin.test.ts
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { answer, cleanup, runFlow } from "@operad-io/engine/testing";

const notes = join(import.meta.dir, "index.ts");

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
| `runFlow(plugin, flow, options?)` | Starts `flow` (a name) in a world of its own and runs it to its end or first wait. Options: `object`, `params`, `settings`, `secrets`, `access`, `clock`, `inProcess`, `store`. The default object is `<first object type>:1`. |
| `answer(run, waitId, choice, note?)` | Records the answer to the wait the run is in, as the CLI does, then runs the world on. A stale `waitId` or a choice the wait does not offer throws. |
| `resume(run)` | Runs the world on after something outside it changed, such as the clock passing a time wait. |
| `emit(plugin, source, type, data?, options?)` | Sends an event through the plugin's trigger rules, as a source plugin would. Options: `key`, `object`, `summary`, and the world options. |
| `testWorld(plugin, options?)` | One world kept across calls: `world.runFlow`, `world.emit`, `world.runs()`, `world.close()`. Use it when a repeated event key must be a repeat, or when one run's end starts another. |
| `fakeClock(start?)` | A clock the test moves: `now()`, `advance(ms)`, `whenTimer()`. Step timeouts and time waits follow it. |
| `memoryStore()` | An empty in-memory object store, for `inProcess` runs that start from objects the test seeds. |
| `cleanup()` | Removes every scratch directory the package made. Call it in `afterAll`. |

A run is a snapshot: `status` (`"ended"`, `"waiting_person"` or `"blocked"`),
`end` (`"done"`, `"failed"` or `"cancelled"` once ended), `wait` (its id, prompt
and choices while a person is asked), `facts` (everything the run recorded, in
order), `history` (one line per step, as `operad history` prints it) and
`store` (the plugin's objects). `answer` and `resume` return a new snapshot.

### Faster, not isolated

`inProcess: true` runs steps in the test's own process against an in-memory
store. It is faster, and it is the only way to give the plugin as a value, to
seed a `memoryStore()`, or to test a plugin defined inside the test file. It is
not isolated: the step shares module state with the test and can return values
a worker could not hand back, so a test can pass in process and fail under
`serve`. Prefer the module path.

### A step that fails

```ts
// example-plugin/failure.test.ts
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, runFlow } from "@operad-io/engine/testing";

const notes = join(import.meta.dir, "index.ts");

afterAll(cleanup);

test("a note with no text ends cancelled and says why", async () => {
  const run = await runFlow(notes, "review");
  expect(run.end).toBe("cancelled");
  expect(run.history.join("\n")).toContain("the review flow needs a text");
});
```

### A step that takes too long

A step that never settles is cut off by the step timeout (five minutes unless
the step sets `timeoutSecs`). With a fake clock the test decides when:

```ts
// example-plugin/slow.ts
import { defineFlow, definePlugin } from "@operad-io/engine";

export default definePlugin({
  name: "slow",
  kind: "domain",
  version: "0.1.0",
  steps: [
    {
      name: "wait-forever",
      results: ["ok", "interrupted"],
      run: () => new Promise(() => undefined),
    },
  ],
  flows: [
    defineFlow({
      name: "stuck",
      entry: "work",
      steps: [
        {
          id: "work",
          kind: "plugin",
          params: { use: "slow/wait-forever", params: {} },
          replay: "safe",
          next: { ok: "done", interrupted: "gave-up" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
        { id: "gave-up", kind: "end", params: { status: "failed" }, replay: "safe" },
      ],
    }),
  ],
});
```

```ts
// example-plugin/timeout.test.ts
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, fakeClock, runFlow } from "@operad-io/engine/testing";

const slow = join(import.meta.dir, "slow.ts");

afterAll(cleanup);

test("a step that never settles is interrupted when the timeout passes", async () => {
  const clock = fakeClock();
  const running = runFlow(slow, "stuck", { clock });
  await clock.whenTimer(); // the step started and its timeout is set
  clock.advance(5 * 60 * 1000); // the default step timeout
  const run = await running;
  expect(run.end).toBe("failed");
  expect(run.history.join("\n")).toContain("took longer than");
});
```

### An event that starts a flow

A plugin that ships `rules` starts flows from events. `emit` sends one the way
a source plugin does:

```ts
// example-plugin/mailbox.ts
import { defineFlow, definePlugin } from "@operad-io/engine";

export default definePlugin({
  name: "mailbox",
  kind: "domain",
  version: "0.1.0",
  objects: [{ name: "mail" }],
  steps: [{ name: "file", results: ["ok"], run: () => ({ result: "ok" }) }],
  flows: [
    defineFlow({
      name: "incoming",
      entry: "file",
      steps: [
        {
          id: "file",
          kind: "plugin",
          params: { use: "mailbox/file", params: {} },
          replay: "safe",
          next: { ok: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    }),
  ],
  rules: [
    {
      source: "mail",
      type: "mail.received",
      start: { flow: "incoming" },
      object: "mail:1",
      mode: "auto",
    },
  ],
});
```

```ts
// example-plugin/emit.test.ts
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, emit, testWorld } from "@operad-io/engine/testing";

const mailbox = join(import.meta.dir, "mailbox.ts");

afterAll(cleanup);

test("an event a rule names starts its flow", async () => {
  const sent = await emit(mailbox, "mail", "mail.received", { subject: "hi" });
  expect(sent.started).toBe(true);
  expect(sent.run?.end).toBe("done");
});

test("an event no rule matches starts nothing", async () => {
  const sent = await emit(mailbox, "mail", "mail.other");
  expect(sent.started).toBe(false);
  expect(sent.run).toBeUndefined();
});

test("the same key arriving twice starts one run", async () => {
  const world = await testWorld(mailbox);
  const first = await world.emit("mail", "mail.received", undefined, { key: "m1" });
  const again = await world.emit("mail", "mail.received", undefined, { key: "m1" });
  expect(first.started).toBe(true);
  expect(again.started).toBe(false);
  expect(await world.runs()).toHaveLength(1);
});
```

## Putting objects in levels

A plugin's `row(object)` may return `parent`: the id of the object one level up.
Give a full id (`plan:repo/P-0001`) or a bare id that resolves the way
`operad show` resolves it. Rows without `parent` are the plugin's top level.
The kernel never invents a parent and does not check that it exists.

```typescript
row: (object) => ({
  id: object.id,
  title: String(object.data.title),
  state: String(object.data.state),
  parent: typeof object.data.parent === "string" ? object.data.parent : undefined,
}),
```

Clients name each type's plugin (`plugin` in `GET /v1/types`) so they can group
types by plugin, list the top level with `root`, and open one level down with
`parent=<id>`. A type's filters apply inside the level. See
[Levels](../user/cli.md#levels) for the exact behaviour, including the order of a list across
types and what an unknown parent returns.

## Putting objects under settings

A plugin whose top-level objects are really settings (a bot's page is that bot's
settings) declares `objectsUnderSettings: true`. No client gives such a plugin a
tab of its own: its top-level objects are listed in the settings view, one group
per type, and open from there as they do from Pending, Running or a group
heading in another tab. Every type of the plugin carries `"settings": true` in
`GET /v1/types` and in the MCP `types` tool, so a client needs no plugin name.

```typescript
export default definePlugin({
  name: "bot",
  kind: "domain",
  version: "0.1.0",
  objects: [{ name: "bot" }],
  objectsUnderSettings: true,
  // ...
});
```

## What an action returns

An action's `run` returns the line of text a person reads, or nothing. An action
that creates an object returns `{ text, opens }` instead, where `opens` is the
new object as `type:id` (for example `chat:C-0015`). The kernel passes `opens`
on unchanged through the client API, `POST /v1/act` and the MCP `act` tool, and
a client may open that object's page; the command line prints only `text`. A
value of `opens` that names no existing object is not passed on, and the log
says why. Returning only text still works.
