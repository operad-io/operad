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

test("a flow with no text ends cancelled and says why", async () => {
  const run = await runFlow(notes, "review");
  expect(run.end).toBe("cancelled");
  expect(run.history.join("\n")).toContain("the review flow needs a text");
});
