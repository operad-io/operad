/** A stand-in worker for runWorkerStep: one tool line, then a done result. */

process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", at: 1 })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    result: "done",
    sessionId: "session-1",
    usage: { input: 3, output: 2, cache_read: 0, cache_write: 0 },
    cost: null,
    finalMessage: "ok",
  })}\n`,
);
