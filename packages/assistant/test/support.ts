import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatPlugin } from "@operad-io/chat";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
  type JsonValue,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import { createAssistantPlugin, syncProfiles } from "../src/index.ts";

const roots: string[] = [];

export async function cleanupRoots(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

export interface Call {
  readonly params: Record<string, unknown>;
  readonly access: JsonValue;
  readonly cwd: string | undefined;
}

function fakeHarness(name: string, calls: Call[]) {
  return definePlugin({
    name,
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        resumable: true,
        results: ["done", "failed", "interrupted", "waiting"],
        run(ctx: StepContext, params): PluginStepResult {
          calls.push({ params: params as Record<string, unknown>, access: ctx.access, cwd: ctx.cwd });
          return { result: "done", data: { finalMessage: "ok", sessionId: "s-1" } };
        },
      },
    ],
  });
}

/** Writes the `assistant` section the way a person editing config.json would. */
export function writeConfig(home: string, profiles: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ plugins: { assistant: { settings: { profiles } } } }, null, 2),
  );
}

export async function rig(profiles: Record<string, unknown> = {}, harnesses = ["harness-claude", "harness-pi"]) {
  const root = await mkdtemp(join(tmpdir(), "assistant-test-"));
  roots.push(root);
  const home = join(root, "home");
  writeConfig(home, profiles);
  const calls: Call[] = [];
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const registry = new PluginRegistry(
    [createChatPlugin(), createAssistantPlugin(), ...harnesses.map((name) => fakeHarness(name, calls))],
    {
      home,
      cwd: root,
      store,
      settings: { assistant: { profiles } },
      onLog: () => undefined,
    },
  );
  await syncProfiles(store, home, { profiles: profiles as Record<string, JsonValue> });
  let runs = 0;
  return {
    root,
    home,
    store,
    registry,
    calls,
    async open(profile: string, args: Record<string, unknown> = {}): Promise<string> {
      const object = await store.get("profile", profile);
      if (object === undefined) throw new Error(`no profile ${profile}`);
      const run = await registry.runAction("assistant/chat", args, {
        object: { type: "profile", id: profile, data: object.data },
        actor: { via: "cli", id: "me" },
      });
      const id = /C-\d+/.exec(String(run.value))?.[0];
      if (id === undefined) throw new Error(`no chat id in ${String(run.value)}`);
      return id;
    },
    async say(chat: string, text: string): Promise<void> {
      await store.append({
        type: "chat.message",
        object: { type: "chat", id: chat },
        cause: "test",
        data: {
          id: `m-${++runs}`,
          role: "user",
          from: { via: "cli", id: "me" },
          text,
          attachments: [],
          source: { kind: "cli", ref: null },
        },
      });
    },
    async reply(chat: string): Promise<PluginStepResult> {
      const object = await store.get("chat", chat);
      if (object === undefined) throw new Error("no chat");
      runs += 1;
      return registry.runStep("chat/reply", {}, {
        runId: `run-${runs}`,
        object: { type: "chat", id: chat, data: object.data },
        params: null,
      });
    },
  };
}
