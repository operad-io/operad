/**
 * Starts a chat reply, writes finished entries and half-written text to its
 * log, says it is ready on stdout and kills itself with SIGKILL. The test that
 * spawns it then recovers the run, as a new `operad serve` would.
 */

import { join } from "node:path";
import {
  PluginRegistry,
  Runner,
  SqlitePluginStore,
  openLog,
  parseObjectKey,
} from "@operad-io/engine";
import {
  MESSAGE_FACT,
  chatRef,
  createChatPlugin,
  newMessageId,
} from "../../src/index.ts";
import { fakeHarness } from "../support.ts";

const home = process.argv[2];
const storeRoot = process.argv[3];
const runId = process.argv[4];
if (home === undefined || storeRoot === undefined || runId === undefined) {
  throw new Error("usage: crash-reply-child <home> <store root> <run id>");
}

const store = new SqlitePluginStore({ root: storeRoot });
const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
let chatId = "";
const registry = new PluginRegistry(
  [
    createChatPlugin(),
    fakeHarness(
      "fake",
      async (ctx) => {
        const line = (value: Record<string, unknown>): Promise<string> =>
          ctx.logger.write(JSON.stringify(value));
        await line({ type: "thinking_end", text: "weighed it", receivedAt: 1_000 });
        await line({ type: "text_end", text: "I looked.", receivedAt: 2_000 });
        await line({
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "Bash",
          input: "ls",
          at: 3_000,
        });
        await line({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "Bash",
          isError: false,
          durationMs: 12,
          receivedAt: 4_000,
        });
        await line({ type: "text_delta", text: "Half a ", receivedAt: 5_000 });
        await line({ type: "text_delta", text: "thought", receivedAt: 5_001 });
        await store.append({
          type: MESSAGE_FACT,
          object: chatRef(chatId),
          cause: "test",
          data: {
            id: newMessageId(),
            role: "user",
            from: { via: "cli", id: "tester" },
            text: "the second question",
            attachments: [],
            source: { kind: "cli", ref: null },
          },
        });
        await new Promise<void>((resolve) => process.stdout.write("ready\n", () => resolve()));
        process.kill(process.pid, "SIGKILL");
        throw new Error("the child did not die");
      },
      [],
    ),
  ],
  {
    home,
    cwd: home,
    store,
    onLog: () => undefined,
  },
);

const run = (await log.runs()).find((candidate) => candidate.runId === runId);
if (run === undefined) throw new Error(`no run ${runId}`);
const found = registry.flow(run.flow);
if (found === undefined) throw new Error(`no flow ${run.flow}`);
const object = parseObjectKey(run.object);
chatId = object?.id ?? "";
await new Runner({
  log,
  flow: found.flow,
  runId,
  registry,
  lockRoot: storeRoot,
  ...(object === undefined ? {} : { object }),
}).run();
await log.close();
