/**
 * Starts a chat reply, writes finished entries and half-written text to its
 * log, says it is ready on stdout and kills itself with SIGKILL. The test that
 * spawns it then recovers the run, as a new `operad serve` would. With
 * `second-round`, the first round records a reply and a message that makes a
 * second round, and the second round is the one the crash cuts off.
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
const mode = process.argv[5] ?? "first-round";
if (home === undefined || storeRoot === undefined || runId === undefined) {
  throw new Error("usage: crash-reply-child <home> <store root> <run id> [second-round]");
}

const store = new SqlitePluginStore({ root: storeRoot });
const log = openLog({ path: join(storeRoot, "log.sqlite") });
let chatId = "";
let round = 0;

async function say(text: string): Promise<void> {
  await store.append({
    type: MESSAGE_FACT,
    object: chatRef(chatId),
    cause: "test",
    data: {
      id: newMessageId(),
      role: "user",
      from: { via: "cli", id: "tester" },
      text,
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
}

/** Says it is ready and kills the whole child with SIGKILL. */
async function die(): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write("ready\n", () => resolve()));
  process.kill(process.pid, "SIGKILL");
  throw new Error("the child did not die");
}

const registry = new PluginRegistry(
  [
    createChatPlugin(),
    fakeHarness(
      "fake",
      async (ctx) => {
        const line = (value: Record<string, unknown>): Promise<string> => {
          const text = JSON.stringify(value);
          ctx.receiver?.(text);
          return ctx.logger.write(text);
        };
        if (mode === "second-round") {
          round += 1;
          if (round === 1) {
            await line({ type: "thinking_end", text: "first thought", receivedAt: 1_000 });
            await line({ type: "text_end", text: "first words", receivedAt: 2_000 });
            await say("the second question");
            return {
              result: "done",
              data: { finalMessage: "first answer", sessionId: "s-1" },
            };
          }
          await line({ type: "thinking_end", text: "second thought", receivedAt: 6_000 });
          await line({ type: "text_end", text: "second words", receivedAt: 7_000 });
          await line({
            type: "tool_execution_start",
            toolCallId: "t2",
            toolName: "Read",
            input: "second.ts",
            at: 8_000,
          });
          await line({
            type: "tool_execution_end",
            toolCallId: "t2",
            toolName: "Read",
            isError: false,
            durationMs: 20,
            receivedAt: 9_000,
          });
          await line({ type: "text_delta", text: "Half a second ", receivedAt: 10_000 });
          await line({ type: "text_delta", text: "thought", receivedAt: 10_001 });
          return die();
        }
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
        await say("the second question");
        return die();
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
