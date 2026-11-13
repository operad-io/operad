/**
 * A real process for the reply restart test. MODE=write polls one update, so a
 * chat exists, then writes an assistant reply and stays alive without sending;
 * MODE=send sweeps the bound chats once against a fake Bot API that records each
 * send in a file, says so, and stays alive. The test kills it either way.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { chatRef, CHAT_TYPE, MESSAGE_FACT } from "@operad-io/chat";
import { FakeApi, createTelegramWorld, update } from "../support.ts";
import { ReplySender } from "../../src/replies.ts";
import { TelegramSource } from "../../src/source.ts";

const root = process.env.TELEGRAM_ROOT;
const mode = process.env.MODE;
const sentPath = process.env.TELEGRAM_SENT;
if (root === undefined || sentPath === undefined || (mode !== "write" && mode !== "send")) {
  console.error("usage: TELEGRAM_ROOT=... TELEGRAM_SENT=... MODE=write|send bun reply.ts");
  process.exit(2);
}

const world = await createTelegramWorld({ root, users: [42] });
const api = new FakeApi();
api.beforeSend = (request) => {
  appendFileSync(sentPath, `${JSON.stringify({ chatId: request.chatId, text: request.text })}\n`);
};
// The reply side exists from the first start, as it does in `operad serve`.
const sender = new ReplySender(world.ctx, { api, wait: async () => undefined });

if (mode === "write") {
  const bound = new FakeApi();
  bound.updates = [update(100, 42, 555, "hello")];
  await new TelegramSource(world.ctx, { api: bound }).poll();
  const chats = await world.store.list(CHAT_TYPE);
  const chat = chats.objects[0];
  if (chat === undefined) throw new Error("no chat was opened");
  await world.ctx.facts.append({
    type: MESSAGE_FACT,
    object: chatRef(chat.id),
    data: {
      id: "m-reply-1",
      role: "assistant",
      from: { via: "agent", id: "default" },
      text: "the answer",
      attachments: [],
      source: { kind: "agent", ref: null },
    },
  });
  process.stdout.write("written\n");
} else {
  await sender.sweepAll();
  const lines = readFileSync(sentPath, "utf8").trim().split("\n").filter((line) => line.length > 0);
  process.stdout.write(`swept ${lines.length}\n`);
}
await new Promise<never>(() => undefined);
