/**
 * The app-server's own question (`item/tool/requestUserInput`, ADR 0026 D6):
 * the client turns it into one form for the person and answers it in the shape
 * the app-server reads.
 */

import { expect, test } from "bun:test";
import { AppServerClient, questionsOf, type AppServerQuestionRequest } from "../src/app-server.ts";

function client(onQuestion?: (request: AppServerQuestionRequest) => Promise<Readonly<Record<string, readonly string[]>>>): AppServerClient {
  return new AppServerClient({
    cwd: "/work",
    prompt: [],
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    clientName: "operad",
    onNotification: () => undefined,
    onPermission: async () => false,
    ...(onQuestion === undefined ? {} : { onQuestion }),
  });
}

/** Feeds one line and resolves with the answer the client writes back. */
function feed(server: AppServerClient, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    server.handleLine(JSON.stringify(message), (text) => {
      resolve(JSON.parse(text) as Record<string, unknown>);
    });
  });
}

const REQUEST = {
  jsonrpc: "2.0",
  id: 7,
  method: "item/tool/requestUserInput",
  params: {
    threadId: "t1",
    turnId: "u1",
    itemId: "i1",
    isBlocking: true,
    questions: [
      {
        id: "loader",
        header: "Loader",
        question: "How should it load?",
        isOther: true,
        options: [
          { label: "Built-in", description: "use the built-in loader" },
          { label: "Dynamic", description: "load it dynamically" },
        ],
      },
    ],
  },
};

test("a request for input becomes a form and is answered per question", async () => {
  let seen: AppServerQuestionRequest | undefined;
  const server = client(async (request) => {
    seen = request;
    return { loader: ["Built-in"] };
  });
  const reply = await feed(server, REQUEST);
  expect(seen).toEqual({
    method: "item/tool/requestUserInput",
    itemId: "i1",
    threadId: "t1",
    turnId: "u1",
    questions: [
      {
        id: "loader",
        question: "How should it load?",
        header: "Loader",
        options: [
          { label: "Built-in", description: "use the built-in loader" },
          { label: "Dynamic", description: "load it dynamically" },
        ],
        isOther: true,
      },
    ],
  });
  expect(reply).toEqual({
    jsonrpc: "2.0",
    id: 7,
    result: { answers: { loader: { answers: ["Built-in"] } } },
  });
});

test("without a question handler the request is refused as an unknown method", async () => {
  const server = client();
  const reply = await feed(server, REQUEST);
  expect(reply).toMatchObject({ id: 7, error: { code: -32601 } });
});

test("a question without an id or text is left out, and a request with none is refused", async () => {
  expect(questionsOf([{ question: "no id?" }, { id: "a", question: "" }, { id: "b", question: "B?" }])).toEqual([
    { id: "b", question: "B?" },
  ]);
  const server = client(async () => ({}));
  const reply = await feed(server, {
    ...REQUEST,
    params: { ...REQUEST.params, questions: [{ question: "no id?" }] },
  });
  expect(reply).toMatchObject({ id: 7, error: { code: -32601 } });
});
