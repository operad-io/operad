import { afterAll, describe, expect, test } from "bun:test";
import { definePlugin, type PluginStepResult } from "@operad-io/engine";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

function steps(calls: { readonly chat: unknown; readonly result: string }[], after?: string) {
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
            data: { cwd: "/tmp", access: {}, skills: [], ...(after === undefined ? {} : { after }) },
          };
        },
      },
      {
        name: "record",
        results: ["done", "failed"],
        run(_ctx, params): PluginStepResult {
          calls.push({ chat: (params as { chat?: unknown }).chat, result: "done" });
          return { result: "done", data: {} };
        },
      },
    ],
  });
}

describe("the step a chat's refresh data names after a reply", () => {
  test("runs once after the reply, with the chat", async () => {
    const calls: { readonly chat: unknown; readonly result: string }[] = [];
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [steps(calls, "settings/record")]);
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "hello");
    const outcome = await r.round(chat);
    expect(outcome.result).toBe("done");
    expect(calls).toEqual([{ chat, result: "done" }]);
  });

  test("does not run when the refresh step names none", async () => {
    const calls: { readonly chat: unknown; readonly result: string }[] = [];
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [steps(calls)]);
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "hello");
    await r.round(chat);
    expect(calls).toEqual([]);
  });

  test("a step that is not loaded leaves the answer as it is", async () => {
    const r = await rig(() => reply("ok", "s-1"), undefined, undefined, "fake", [steps([], "nowhere/record")]);
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "hello");
    const outcome = await r.round(chat);
    expect(outcome.result).toBe("done");
  });
});
