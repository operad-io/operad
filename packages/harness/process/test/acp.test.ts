import { describe, expect, test } from "bun:test";
import {
  AcpClient,
  permissionOptionFor,
  type AcpEnd,
  type AcpPermissionOption,
  type AcpPermissionRequest,
} from "../src/acp.ts";

function harness(
  options: Partial<ConstructorParameters<typeof AcpClient>[0]> = {},
): {
  client: AcpClient;
  sent: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  permissions: AcpPermissionRequest[];
  feed: (message: Record<string, unknown>) => void;
  answer: (id: number, result: Record<string, unknown>) => void;
  end: () => Promise<AcpEnd>;
  /** Resolves with the next line the client sends. */
  nextReply: () => Promise<void>;
} {
  const sent: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const permissions: AcpPermissionRequest[] = [];
  const client = new AcpClient({
    cwd: "/w",
    prompt: [{ type: "text", text: "hi" }],
    clientName: "operad",
    onUpdate: (update) => void updates.push(update),
    onPermission: (request) => {
      permissions.push(request);
      return Promise.resolve(true);
    },
    ...options,
  });
  const waiters: Array<() => void> = [];
  const reply = (text: string): void => {
    sent.push(JSON.parse(text) as Record<string, unknown>);
    for (const waiter of waiters.splice(0)) waiter();
  };
  sent.push(JSON.parse(client.first) as Record<string, unknown>);
  const feed = (message: Record<string, unknown>): void => client.handleLine(JSON.stringify(message), reply);
  const answer = (id: number, result: Record<string, unknown>): void => feed({ jsonrpc: "2.0", id, result });
  const nextReply = (): Promise<void> => new Promise<void>((resolve) => void waiters.push(resolve));
  return { client, sent, updates, permissions, feed, answer, end: () => client.ended, nextReply };
}

const lastId = (sent: Record<string, unknown>[]): number => Number(sent.at(-1)?.id);

describe("AcpClient", () => {
  test("initialize, session/new, the settings, then the prompt, in that order", async () => {
    const h = harness({ config: [{ configId: "mode", value: "workspace-write" }] });
    expect(h.sent[0]?.method).toBe("initialize");
    h.answer(lastId(h.sent), { agentCapabilities: {} });
    expect(h.sent.at(-1)?.method).toBe("session/new");
    h.answer(lastId(h.sent), { sessionId: "s1" });
    expect(h.sent.at(-1)).toMatchObject({ method: "session/set_config_option", params: { sessionId: "s1", configId: "mode", value: "workspace-write" } });
    h.answer(lastId(h.sent), {});
    expect(h.sent.at(-1)).toMatchObject({ method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } });
    h.answer(lastId(h.sent), { stopReason: "end_turn", usage: { inputTokens: 2 } });
    expect(await h.end()).toEqual({ kind: "stopped", stopReason: "end_turn", usage: { inputTokens: 2 }, meta: null, sessionId: "s1" });
  });

  test("a resumed session is loaded, and its replayed history is dropped", () => {
    const h = harness({ resumeSession: "old" });
    h.answer(lastId(h.sent), { agentCapabilities: { loadSession: true } });
    expect(h.sent.at(-1)).toMatchObject({ method: "session/load", params: { sessionId: "old", cwd: "/w" } });
    h.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old", update: { sessionUpdate: "agent_message_chunk" } } });
    h.answer(lastId(h.sent), {});
    expect(h.sent.at(-1)?.method).toBe("session/prompt");
    h.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "old", update: { sessionUpdate: "tool_call" } } });
    expect(h.updates).toEqual([{ sessionUpdate: "tool_call" }]);
  });

  test("an agent without loadSession cannot resume", async () => {
    const h = harness({ resumeSession: "old" });
    h.answer(lastId(h.sent), { agentCapabilities: { loadSession: false } });
    const end = await h.end();
    expect(end).toMatchObject({ kind: "error", stage: "session" });
    expect(h.sent.map((message) => message.method)).toEqual(["initialize"]);
  });

  test("an error response ends the run at the stage that asked, naming the setting", async () => {
    const h = harness({ config: [{ configId: "model", value: "nope" }] });
    h.answer(lastId(h.sent), {});
    h.answer(lastId(h.sent), { sessionId: "s1" });
    h.feed({ jsonrpc: "2.0", id: lastId(h.sent), error: { code: -32602, message: "Invalid params" } });
    expect(await h.end()).toMatchObject({ kind: "error", stage: "config", configId: "model", error: { code: -32602 } });
  });

  test("cancel sends session/cancel once, only while the prompt is in flight", () => {
    const h = harness();
    expect(h.client.cancel()).toBe(false);
    h.answer(lastId(h.sent), {});
    h.answer(lastId(h.sent), { sessionId: "s1" });
    expect(h.client.prompting).toBe(true);
    expect(h.client.cancel()).toBe(true);
    expect(h.client.cancel()).toBe(false);
    expect(h.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
  });

  test("a permission request is answered with the once-option, never the always-option", async () => {
    const h = harness();
    h.answer(lastId(h.sent), {});
    h.answer(lastId(h.sent), { sessionId: "s1" });
    const replied = h.nextReply();
    h.feed({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { toolCallId: "c" },
        options: [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
          { optionId: "no", name: "No", kind: "reject_once" },
        ],
      },
    });
    await replied;
    expect(h.permissions).toHaveLength(1);
    expect(h.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "once" } } });
  });

  test("an agent request this client does not serve gets a method-not-found error", () => {
    const h = harness();
    h.feed({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: {} });
    expect(h.sent.at(-1)).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  test("a line that is not JSON is ignored", () => {
    const h = harness();
    h.client.handleLine("not json", () => undefined);
    expect(h.client.finished).toBe(false);
  });
});

describe("permissionOptionFor", () => {
  const options: AcpPermissionOption[] = [
    { optionId: "a", name: "a", kind: "allow_always" },
    { optionId: "r", name: "r", kind: "reject_always" },
  ];
  test("an allow with only the always-option offered has no option, and a refusal falls back to reject_always", () => {
    expect(permissionOptionFor(options, true)).toBeUndefined();
    expect(permissionOptionFor(options, false)?.optionId).toBe("r");
    expect(permissionOptionFor([], false)).toBeUndefined();
  });
});
