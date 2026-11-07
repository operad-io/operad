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
