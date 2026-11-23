import { afterAll, describe, expect, test } from "bun:test";
import { allMessages, deliverResult, messageMarkdown, type Delivery } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

const FULL = "Three items today. ".repeat(40).trim();

function delivery(runId: string, extra: Partial<Delivery> = {}): Delivery {
  return {
    routine: "Morning news",
    runId,
    summary: "Three items; the first is about rates.",
    text: FULL,
    from: { via: "bot", id: "Morning news" },
    ...extra,
  };
}

async function deliver(r: Rig, chat: string, item: Delivery): Promise<boolean> {
  return deliverResult({ store: r.store, facts: { append: async (input) => r.store.append({ ...input, cause: "test" }) } }, chat, item);
}

describe("a delivered result", () => {
  test("is a message of its own in the chat, headed with the routine, and starts no reply", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    expect(await deliver(r, chat, delivery("R-0001"))).toBe(true);
    const messages = allMessages(r.store, chat);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "delivery", text: FULL, delivery: { routine: "Morning news", runId: "R-0001" } });
    expect(r.calls).toHaveLength(0);
    const shown = messageMarkdown(messages[0] ?? (() => { throw new Error("no message"); })());
    expect(shown.split("\n")[0]).toContain("Routine · Morning news");
    expect(shown).toContain(FULL);
  });

  test("is recorded once for one run", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    expect(await deliver(r, chat, delivery("R-0001"))).toBe(true);
    expect(await deliver(r, chat, delivery("R-0001"))).toBe(false);
    expect(allMessages(r.store, chat)).toHaveLength(1);
  });

  test("rides on the next message as its summary, not its whole text, and only once", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await deliver(r, chat, delivery("R-0001"));
    await deliver(r, chat, delivery("R-0002", { routine: "Dreaming", summary: "Tidied two notes." }));
    expect(r.calls).toHaveLength(1);
    await r.say(chat, "two");
    await r.round(chat);
    const prompt = String(r.calls[1]?.params.prompt);
    expect(prompt).toContain("[Routine results]");
    expect(prompt).toContain("Morning news, run R-0001: Three items; the first is about rates.");
    expect(prompt).toContain("Dreaming, run R-0002: Tidied two notes.");
    expect(prompt).toContain(`chat:<run>`);
    expect(prompt).not.toContain(FULL);
    expect(prompt.indexOf("[End of routine results]")).toBeLessThan(prompt.lastIndexOf("two"));
    await r.say(chat, "three");
    await r.round(chat);
    expect(String(r.calls[2]?.params.prompt)).not.toContain("Routine results");
  });

  test("a failed run says so in the header and the carried line", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await deliver(r, chat, delivery("R-0003", { failed: true, summary: "agent crashed", text: "agent crashed" }));
    const message = allMessages(r.store, chat)[0];
    if (message === undefined) throw new Error("no message");
    expect(messageMarkdown(message)).toContain("Routine · Morning news · failed");
    await r.say(chat, "hi");
    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).toContain("Morning news (failed), run R-0003: agent crashed");
  });
});
