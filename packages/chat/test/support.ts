import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
  type PluginStepResult,
  type StepContext,
  type StepEvent,
  type TriggerEvent,
} from "@operad-io/engine";
import { chatRef, createChat, MESSAGE_FACT, newMessageId, createChatPlugin } from "../src/index.ts";

const roots: string[] = [];

export async function cleanupRoots(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** One call the fake harness received. */
export interface Call {
  readonly params: Record<string, unknown>;
}

/** What a fake harness does with one call. */
export type Script = (ctx: StepContext, call: Call) => Promise<PluginStepResult> | PluginStepResult;

/** A harness plugin whose answers the test writes. */
export function fakeHarness(name: string, script: Script, calls: Call[], models?: { readonly list: readonly string[]; readonly default: string | null }) {
  return definePlugin({
    name,
    kind: "harness",
    version: "0.0.0",
    ...(models === undefined ? {} : { models }),
    steps: [
      {
        name: "agent",
        resumable: true,
        results: ["done", "failed", "interrupted", "waiting"],
        run(ctx, params) {
          const call: Call = { params: params as Record<string, unknown> };
          calls.push(call);
          return script(ctx, call);
        },
      },
    ],
  });
}

/** A reply the fake harness gives. */
export function reply(text: string, sessionId = "s-1"): PluginStepResult {
  return { result: "done", data: { finalMessage: text, sessionId } };
}

export interface Rig {
  readonly registry: PluginRegistry;
  readonly store: MemoryPluginStore;
  readonly root: string;
  readonly calls: Call[];
  readonly events: TriggerEvent[];
  /** A chat that uses the fake harness. */
  chat(extra?: { readonly access?: Record<string, never> | Record<string, boolean>; readonly model?: string }): Promise<string>;
  /** A person's message as a fact, without the event. */
  say(chat: string, text: string): Promise<string>;
  /** Runs one round of the reply step. */
  round(
    chat: string,
    params?: Record<string, unknown>,
    asker?: Parameters<PluginRegistry["runStep"]>[2]["asker"],
    onEmit?: (event: StepEvent) => void,
  ): Promise<PluginStepResult>;
}

export async function rig(script: Script, models?: { readonly list: readonly string[]; readonly default: string | null }): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "chat-test-"));
  roots.push(root);
  const calls: Call[] = [];
  const events: TriggerEvent[] = [];
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const registry = new PluginRegistry([createChatPlugin(), fakeHarness("fake", script, calls, models)], {
    home: join(root, "home"),
    cwd: root,
    store,
    onLog: () => undefined,
    onEvent: (event) => {
      events.push(event);
    },
  });
  let runs = 0;
  return {
    registry,
    store,
    root,
    calls,
    events,
    async chat(extra) {
      return createChat(
        store,
        { harness: "fake", cwd: root, title: "Test", ...(extra?.access === undefined ? {} : { access: extra.access }), ...(extra?.model === undefined ? {} : { model: extra.model }) },
        "test",
      );
    },
    async say(chat, text) {
      const id = newMessageId();
      await store.append({
        type: MESSAGE_FACT,
        object: chatRef(chat),
        cause: "test",
        data: {
          id,
          role: "user",
          from: { via: "cli", id: "tester" },
          text,
          attachments: [],
          source: { kind: "cli", ref: null },
        },
      });
      return id;
    },
    async round(chat, params = {}, asker, onEmit) {
      const object = await store.get("chat", chat);
      if (object === undefined) throw new Error("no chat");
      runs += 1;
      return registry.runStep("chat/reply", params, {
        runId: `run-${runs}`,
        object: { type: "chat", id: chat, data: object.data },
        params: null,
        ...(asker === undefined ? {} : { asker }),
        ...(onEmit === undefined ? {} : { emit: (_plugin: string, event: StepEvent) => onEmit(event) }),
      });
    },
  };
}
