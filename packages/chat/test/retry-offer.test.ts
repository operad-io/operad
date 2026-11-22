import { afterAll, describe, expect, test } from "bun:test";
import { Views, type StepContext } from "@operad-io/engine";
import { CHAT_TYPE, chatRef, RUN_FACT } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** A gate one script call opens and another waits on, so a test waits for the event. */
function latch(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Waits for the stop the rig sends, without sleeping for it. */
function stopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function send(ctx: StepContext, line: Record<string, unknown>): void {
  ctx.receiver?.(JSON.stringify(line));
}

async function objectOf(r: Rig, chat: string) {
  const found = await r.store.get(CHAT_TYPE, chat);
  if (found === undefined) throw new Error(`there is no chat ${chat}`);
  return found;
}

/** The actions the chat offers now, as a client reads them over HTTP. */
async function offered(r: Rig, chat: string): Promise<readonly string[]> {
  const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
  return (await views.get(`${CHAT_TYPE}:${chat}`)).actions.map((action) => action.name);
}

/** The line a client's act gets when an action is not offered. */
async function refusal(r: Rig, chat: string): Promise<string> {
  const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
  try {
    await views.act("chat:retry", `${CHAT_TYPE}:${chat}`, { actor: { via: "cli", id: "me" } });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the action ran; the test expected it to be refused");
}

/** A command a person types in the chat. */
async function command(r: Rig, chat: string, text: string) {
  return r.registry.runAction(
    "chat/send",
    { note: text },
    { object: await objectOf(r, chat), actor: { via: "cli", id: "me" } },
  );
}

/** What a reply that fails records. */
const FAILED = { result: "failed", data: { reason: "model_error", message: "boom" } } as const;

describe("chat:retry is offered only when it would start a reply", () => {
  test("a failed reply offers it, and a typed retry answers once", async () => {
    let calls = 0;
    const r = await rig(() => {
      calls += 1;
      return calls === 1 ? FAILED : reply("second answer", "s-2");
    });
    const chat = await r.chat();
    expect(await offered(r, chat)).not.toContain("chat:retry");
    await r.say(chat, "one");
    expect((await r.round(chat)).result).toBe("failed");

    expect(await offered(r, chat)).toContain("chat:retry");
    const typed = await command(r, chat, "/retry");
    expect(typed.value).toBe("retrying the last message");
    expect(r.events.map((event) => event.key)).toEqual(["retry:run-1"]);
  });

  test("a run the host says has ended does not keep a failed attempt from being retried", async () => {
    const r = await rig(() => FAILED);
    const chat = await r.chat();
    await r.say(chat, "one");
    expect((await r.round(chat)).result).toBe("failed");

    // A later attempt crashed before recording a failure; the host says its run is gone.
    await r.store.append({
      type: RUN_FACT,
      object: chatRef(chat),
      cause: "test",
      data: { runId: "run-crashed" },
    });
    expect(await offered(r, chat)).toContain("chat:retry");
    const typed = await command(r, chat, "/retry");
    expect(typed.value).toBe("retrying the last message");
    expect(r.events.map((event) => event.key)).toEqual(["retry:run-1"]);
  });

  test("a stop offers it at once, before the stopped half reply enters the record", async () => {
    const entered = latch();
    let calls = 0;
    const r = await rig(async (ctx) => {
      calls += 1;
      if (calls === 1) return reply("first answer", "s-1");
      send(ctx, { type: "text_delta", text: "half a thought" });
      entered.open();
      await stopped(ctx.signal);
      return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
    });
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await r.say(chat, "two");
    const round = r.round(chat);
    await entered.promise;
    expect(await offered(r, chat)).not.toContain("chat:retry");

    await command(r, chat, "/stop");
    // The stop fact names the run before the reply's own stopping is recorded.
    expect(await offered(r, chat)).toContain("chat:retry");
    expect((await round).result).toBe("interrupted");
    expect(await offered(r, chat)).toContain("chat:retry");
  });

  test("a finished reply does not offer it, and says why", async () => {
    const r = await rig(() => reply("a good answer"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    expect(await offered(r, chat)).not.toContain("chat:retry");
    expect(await refusal(r, chat)).toBe("the last reply finished normally; there is nothing to retry");
    const typed = await command(r, chat, "/retry");
    expect(typed.value).toBe("refused: the last reply finished normally; there is nothing to retry");
    expect(r.events).toEqual([]);
  });

  test("a message no attempt answered does not offer it, and a typed retry keeps its line", async () => {
    const r = await rig(() => reply("a good answer"));
    const chat = await r.chat();
    await r.say(chat, "hello");

    expect(await offered(r, chat)).not.toContain("chat:retry");
    expect(await refusal(r, chat)).toBe(
      "the last reply has not failed or stopped; there is nothing to retry",
    );
    const typed = await command(r, chat, "/retry");
    expect(typed.value).toBe(
      "refused: the last reply has not failed or stopped; there is nothing to retry",
    );
    expect(r.events).toEqual([]);
  });

  test("a reply being written does not offer it, even after a failed attempt", async () => {
    const entered = latch();
    const gate = latch();
    let calls = 0;
    const r = await rig(async () => {
      calls += 1;
      if (calls === 1) return FAILED;
      entered.open();
      await gate.promise;
      return reply("late answer", "s-3");
    });
    const chat = await r.chat();
    await r.say(chat, "one");
    expect((await r.round(chat)).result).toBe("failed");
    expect(await offered(r, chat)).toContain("chat:retry");

    await r.say(chat, "two");
    const round = r.round(chat);
    await entered.promise;
    expect(await offered(r, chat)).not.toContain("chat:retry");
    const writing = `chat ${chat} is writing a reply; retry is offered once it ends`;
    expect(await refusal(r, chat)).toBe(writing);
    // The offer is gone, so a typed retry starts nothing and keeps the reason.
    const typed = await command(r, chat, "/retry");
    expect(typed.value).toBe(`refused: ${writing}`);
    expect(r.events).toEqual([]);

    gate.open();
    expect((await round).result).toBe("done");
    expect(await offered(r, chat)).not.toContain("chat:retry");
  });

  test("a closed chat does not offer it, and says why", async () => {
    const r = await rig(() => reply("a good answer"));
    const chat = await r.chat();
    await r.registry.runAction("chat/close", {}, {
      object: await objectOf(r, chat),
      actor: { via: "cli", id: "me" },
    });

    expect(await offered(r, chat)).not.toContain("chat:retry");
    expect(await refusal(r, chat)).toBe(`chat ${chat} is closed; there is nothing to retry`);
  });

  test("the run checks the rule again when a reply started after the offer", async () => {
    const r = await rig(() => reply("a good answer"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);

    // A host runs the action without the offer's check, as a client's act does
    // when the state changed between the two.
    await expect(
      r.registry.runAction("chat/retry", {}, {
        object: await objectOf(r, chat),
        actor: { via: "cli", id: "me" },
      }),
    ).rejects.toThrow("the last reply finished normally; there is nothing to retry");
    expect(r.events).toEqual([]);
  });
});
