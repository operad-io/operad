// example-plugin/failure.test.ts
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, runFlow } from "@operad-io/engine/testing";

const notes = join(import.meta.dir, "..", "..", "fixtures", "example-plugin", "index.ts");

afterAll(cleanup);

test("a note with no text ends cancelled and says why", async () => {
  const run = await runFlow(notes, "review");
  expect(run.end).toBe("cancelled");
  expect(run.history.join("\n")).toContain("the review flow needs a text");
});
