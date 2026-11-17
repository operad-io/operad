import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, Views } from "@operad-io/engine";
import { createPiHarnessPlugin } from "@operad-io/harness-pi";
import { createChat, createChatPlugin } from "../src/index.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function rig(piSettings: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "chat-current-"));
  roots.push(root);
  const settingsPath = join(root, "pi-settings.json");
  writeFileSync(settingsPath, JSON.stringify(piSettings));
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const registry = new PluginRegistry(
    [
      createChatPlugin(),
      createPiHarnessPlugin({ piSettingsPath: settingsPath }),
    ],
    {
      home: root,
      cwd: root,
      store,
      settings: { pi: { models: ["zai/glm-5"], model: "zai/glm-5" } },
      onLog: () => undefined,
    },
  );
  const views = new Views({ registry, store, onLog: () => undefined });
  const chat = async (effort?: string): Promise<string> =>
    createChat(
      store,
      {
        harness: "pi",
        cwd: root,
        title: "Test",
        ...(effort === undefined ? {} : { effort, effortDefault: "high" }),
      },
      "test",
    );
  const offered = async (id: string, action: string) =>
    (await views.get(`chat:${id}`)).actions
      .find((item) => item.name === action)
      ?.args?.properties;
  return { chat, offered };
}

describe("the value a chat action offers as current", () => {
  test("a pi chat with no effort offers pi's own defaultThinkingLevel", async () => {
    const r = await rig({ defaultThinkingLevel: "high" });
    const chat = await r.chat();
    const effort = (await r.offered(chat, "chat:effort"))?.effort;
    expect(effort?.current).toBe("high");
    expect(effort?.default).toBe("high");
  });

  test("a chat that picked an effort offers that effort", async () => {
    const r = await rig({ defaultThinkingLevel: "high" });
    const chat = await r.chat("low");
    expect((await r.offered(chat, "chat:effort"))?.effort?.current).toBe("low");
  });

  test("a chat with no model offers the configured model", async () => {
    const r = await rig({ defaultThinkingLevel: "high" });
    const chat = await r.chat();
    expect((await r.offered(chat, "chat:model"))?.model?.current).toBe("zai/glm-5");
  });
});
