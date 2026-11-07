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
