/**
 * The flow every harness plugin offers beside its step: one agent turn, and a
 * person's answer to a question about a call sending the run back to it.
 */

import { defineFlow } from "@operad-io/engine";

/** The prompt flow of a harness: its `agent` step, then a person's answer. */
export function promptFlowOf(name: string, use: string) {
  return defineFlow({
    name,
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use, params: {} },
        replay: "unsafe",
        next: { done: "done", failed: "failed", interrupted: "cancelled", waiting: "person" },
      },
      {
        // A question about a call ran out of grace. The answer sends the run
        // back to the agent, which continues the session with it.
        id: "person",
        kind: "wait_person",
        params: {
          prompt: "The agent asked about a call.",
          choices: ["allow_once", "reject_once"],
          lateChoices: ["allow_always"],
        },
        replay: "safe",
        next: {
          allow_once: "agent",
          allow_always: "agent",
          reject_once: "agent",
          interrupted: "cancelled",
        },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      { id: "cancelled", kind: "end", params: { status: "cancelled" }, replay: "safe" },
    ],
  });
}
