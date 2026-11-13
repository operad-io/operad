import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  createViews,
  definePlugin,
  openLog,
  readHttpToken,
  startHttpServer,
  type Fact,
  type LogBackend,
  type RunnerOutcome,
} from "@operad-io/engine";
import {
  allMessages,
  chatRef,
  createChat,
  createChatPlugin,
  MESSAGE_FACT,
  newMessageId,
  WORKTREE_CHOICES,
  WORKTREE_QUESTION,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

interface Open {
  readonly store: MemoryPluginStore;
  readonly chat: string;
  readonly log: LogBackend;
  readonly runId: string;
  readonly running: Promise<RunnerOutcome>;
  readonly base: string;
  readonly token: string;
  close(): Promise<void>;
}

/** Opens one read-only chat whose first agent call asks the worktree question. */
async function openChatAsk(): Promise<Open> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const log = openLog({ backend: "sqlite", path: join(root, "store", "log.sqlite") });
  let calls = 0;
  const harness = definePlugin({
    name: "fake",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        resumable: true,
        results: ["done", "failed", "interrupted", "waiting"],
        async run(ctx) {
          if (calls === 0) {
            await ctx.ask({
              prompt: WORKTREE_QUESTION,
              choices: [...WORKTREE_CHOICES],
              graceSecs: 600,
            });
          }
          calls += 1;
          return {
            result: "done" as const,
            data: { finalMessage: "opened it", sessionId: "s-1" },
          };
        },
      },
    ],
  });
  const registry = new PluginRegistry([createChatPlugin(), harness], {
    home,
    cwd: root,
    store,
    onLog: () => undefined,
  });
  const views = createViews({ registry, store, log, home, onLog: () => undefined });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  if (token === undefined) throw new Error("the server created no token");
  const base = server.urls[0];
  if (base === undefined) throw new Error("the server bound no address");

  const chat = await createChat(
    store,
    { harness: "fake", cwd: root, title: "Read-only", access: { readOnly: true } },
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
  }).run();

  return {
    store,
    chat,
    log,
    runId: info.runId,
    running,
    base,
    token: token.token,
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}

/** The run's facts so far. */
async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

/** Waits until the run has opened its question, without sleeping for it. */
async function openedAsk(log: LogBackend, runId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let busy = false;
    let again = false;
    let unsubscribe = (): void => undefined;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const look = async (): Promise<void> => {
      if (finished) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const list = await facts(log, runId);
          if (list.some((fact) => fact.kind === "ask_opened")) return finish();
        } while (again);
      } catch (error) {
        finish(error);
      } finally {
        busy = false;
      }
    };
    unsubscribe = log.subscribe?.(() => void look()) ?? (() => undefined);
    void look();
  });
}

describe("answering a chat's worktree question", () => {
  test("no over HTTP resumes the reply, and a stale answer is refused", async () => {
    const open = await openChatAsk();
    try {
      await openedAsk(open.log, open.runId);
      const auth = {
        authorization: `Bearer ${open.token}`,
        "x-operad-client": "ios",
      };

      const pendingResponse = await fetch(`${open.base}/v1/pending`, { headers: auth });
      expect(pendingResponse.status).toBe(200);
      const pending = (await pendingResponse.json()) as {
        readonly runId: string;
        readonly waitId?: string;
        readonly prompt: string;
        readonly choices: readonly string[];
      }[];
      expect(pending).toHaveLength(1);
      expect(pending[0]?.runId).toBe(open.runId);
      expect(pending[0]?.waitId).toBeDefined();
      expect(pending[0]?.prompt).toBe(WORKTREE_QUESTION);
      expect(pending[0]?.choices).toEqual([...WORKTREE_CHOICES]);
      const waitId = pending[0]?.waitId;
      if (waitId === undefined) throw new Error("the item named no wait id");

      const answered = await fetch(`${open.base}/v1/answer`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ runId: open.runId, waitId, choice: "no" }),
      });
      expect(answered.status).toBe(200);
      expect(await open.running).toBe("ended");
      expect(
        allMessages(open.store, open.chat)
          .filter((message) => message.role === "assistant")
          .map((message) => message.text),
      ).toEqual(["opened it"]);

      const stale = await fetch(`${open.base}/v1/answer`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ runId: open.runId, waitId, choice: "yes" }),
      });
      expect(stale.status).toBe(409);
      const refused = (await stale.json()) as { error?: { message?: string } };
      expect(refused.error?.message).toContain("not waiting for a person");
    } finally {
      await open.close();
    }
  }, 30_000);
});
