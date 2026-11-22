// A harness that answers at once and does nothing else. Test-only: no production path loads it.

import { definePlugin, type PluginStepResult } from "@operad-io/engine";

export default definePlugin({
  name: "idle",
  kind: "harness",
  version: "0.0.0",
  capabilities: { accessLevels: ["plan", "ask", "edits", "full"] },
  models: { list: [], default: null },
  efforts: { list: [], default: null },
  steps: [
    {
      name: "agent",
      resumable: true,
      results: ["done", "failed", "interrupted", "waiting"],
      run(): PluginStepResult {
        return { result: "done", data: { finalMessage: "ok", sessionId: "s-1" } };
      },
    },
  ],
});
