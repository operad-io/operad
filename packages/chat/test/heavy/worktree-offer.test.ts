import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  definePlugin,
  openLog,
  type Fact,
  type LogBackend,
} from "@operad-io/engine";
import { chatRef, createChat, createChatPlugin, MESSAGE_FACT, newMessageId } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const ASKED = "Run this command?";

/** Runs one reply of a read-only chat whose agent asks about a command; returns the prompt a person is asked. */
async function promptOf(worktreeOffer: boolean | undefined): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const log = openLog({ path: join(root, "store", "log.sqlite") });
  const harness = definePlugin({
    name: "fake",
    kind: "harness",
    version: "0.0.0",
    capabilities: { accessLevels: ["plan", "ask", "edits", "full"] },
    steps: [
      {
        name: "agent",
        resumable: true,
        results: ["done", "failed", "interrupted", "waiting"],
        async run(ctx) {
          await ctx.ask({ prompt: ASKED, choices: ["Yes", "No"], graceSecs: 600 });
          return { result: "done" as const, data: { finalMessage: "ok", sessionId: "s-1" } };
        },
      },
    ],
  });
  const settings = definePlugin({
    name: "place",
    kind: "domain",
    version: "0.0.0",
    steps: [
      {
        name: "settings",
        results: ["done"],
        run: () => ({
          result: "done" as const,
          data: {
            cwd: root,
            access: { readOnly: true },
            skills: [],
            ...(worktreeOffer === undefined ? {} : { worktreeOffer }),
          },
        }),
      },
    ],
  });
  const registry = new PluginRegistry([createChatPlugin(), harness, settings], {
    home,
    cwd: root,
    store,
    onLog: () => undefined,
  });
  const chat = await createChat(
    store,
    { harness: "fake", cwd: root, title: "T", access: { readOnly: true }, refresh: "place/settings" },
    "test",
  );
  await store.append({
    type: MESSAGE_FACT,
    object: chatRef(chat),
    cause: "test",
    data: {
      id: newMessageId(),
      role: "user",
      from: { via: "cli", id: "tester" },
      text: "change it",
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
  const info = await log.startRun("chat:reply", `chat:${chat}`);
  const found = registry.flow("chat:reply");
  if (found === undefined) throw new Error("no chat flow");
  const running = new Runner({
    log,
    flow: found.flow,
    runId: info.runId,
    registry,
    lockRoot: join(root, "locks"),
    object: { type: "chat", id: chat },
  })
    .run()
    .catch(() => undefined);
  try {
    return await opened(log, info.runId);
  } finally {
    await log.close();
    await running;
  }
}

/** The prompt of the run's first question, waiting for the event and not sleeping. */
function opened(log: LogBackend, runId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    let done = false;
    const look = async (): Promise<void> => {
      if (done) return;
      try {
        for await (const fact of log.read(runId)) {
          const found = promptIn(fact);
          if (fact.kind === "ask_opened" && found !== undefined) {
            done = true;
            unsubscribe();
            resolve(found);
            return;
          }
        }
      } catch (error) {
        done = true;
        unsubscribe();
        reject(error);
      }
    };
    unsubscribe = log.subscribe?.(() => void look()) ?? (() => undefined);
    void look();
  });
}

function promptIn(fact: Fact): string | undefined {
  const data: unknown = fact.payload;
  if (typeof data !== "object" || data === null) return undefined;
  const prompt: unknown = Reflect.get(data, "prompt");
  return typeof prompt === "string" ? prompt : undefined;
}

describe("the worktree question", () => {
  test("a read-only chat asks the worktree question about a command", async () => {
    expect(await promptOf(undefined)).not.toBe(ASKED);
  }, 30_000);

  test("a chat that works in its main clone is asked the plain question, with no worktree offer", async () => {
    expect(await promptOf(false)).toBe(ASKED);
  }, 30_000);
});
