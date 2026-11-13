// example-plugin/timeout.test.ts
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, fakeClock, runFlow } from "@operad-io/engine/testing";

const slow = join(import.meta.dir, "..", "..", "fixtures", "example-plugin", "slow.ts");

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
