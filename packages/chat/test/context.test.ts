import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { definePlugin, type PluginStepResult } from "@operad-io/engine";
import { allMessages } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

const FULL = "THE WHOLE STARTING TEXT";
const WHERE = "WHERE THE CHAT IS NOW";

function refreshStep(cwd: () => string) {
  return definePlugin({
    name: "settings",
    kind: "domain",
    version: "0.0.0",
    steps: [
      {
        name: "refresh",
        results: ["done", "failed"],
        run(): PluginStepResult {
          return {
            result: "done",
            data: {
              cwd: cwd(),
              access: { readOnly: true },
              skills: [],
              context: { text: FULL, where: WHERE },
            },
          };
        },
      },
    ],
  });
}

describe("a repository chat's starting text", () => {
  test("goes before the first message, and not again in that session", async () => {
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [refreshStep(() => r.root)]);
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "first");
    await r.round(chat);
    expect(r.calls[0]?.params.prompt).toBe(`${FULL}\n\nfirst`);

    await r.say(chat, "second");
    await r.round(chat);
    expect(r.calls[1]?.params.prompt).toBe("second");
    expect((await r.store.get("chat", chat))?.data.contextCwd).toBe(r.root);
  });

  test("a bot chat, with no refresh step, gets none", async () => {
    const r = await rig(() => reply("ok", "s-1"));
    const chat = await r.chat();
    await r.say(chat, "hello");
    await r.round(chat);
    expect(r.calls[0]?.params.prompt).toBe("hello");
  });

  test("after the chat moves to its worktree, the next message gets the place alone, once", async () => {
    let cwd = "";
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [refreshStep(() => cwd)]);
    cwd = r.root;
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "first");
    await r.round(chat);
    expect(r.calls[0]?.params.prompt).toBe(`${FULL}\n\nfirst`);

    const worktree = join(r.root, "worktree");
    cwd = worktree;
    await r.say(chat, "second");
    await r.round(chat);
    expect(r.calls[1]?.params.prompt).toBe(`${WHERE}\n\nsecond`);
    expect((await r.store.get("chat", chat))?.data.contextCwd).toBe(worktree);

    await r.say(chat, "third");
    await r.round(chat);
    expect(r.calls[2]?.params.prompt).toBe("third");
  });

  test("the person's message stays as it was sent in the transcript", async () => {
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [refreshStep(() => r.root)]);
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "the message");
    await r.round(chat);
    expect(allMessages(r.store, chat).find((message) => message.role === "user")?.text).toBe("the message");
  });
});
