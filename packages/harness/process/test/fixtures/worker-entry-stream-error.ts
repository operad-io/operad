/**
 * Writes one line, waits for the host to close stdout and name a file, then
 * writes another. A worker entry must keep a closed stdout from failing it.
 * Usage: bun worker-entry-stream-error.ts <go-file>
 */
import { waitForFile } from "@operad-io/engine/testing";
import { runWorkerMain, type WorkerAdapter } from "../../src/index.ts";

interface Input {
  readonly go: string;
}

const adapter: WorkerAdapter<Input> = {
  parse(text) {
    try {
      const value: unknown = JSON.parse(text);
      const go = typeof value === "object" && value !== null && "go" in value ? value.go : undefined;
      if (typeof go !== "string") return { ok: false, message: "go must be a string" };
      return { ok: true, input: { go } };
    } catch {
      return { ok: false, message: "the input is not valid JSON" };
    }
  },
  invalidInput: (message) => ({ type: "failed", message }),
  error: (message) => ({ type: "failed", message }),
  keep: () => undefined,
  async run(input, io) {
    io.line({ type: "first" });
    await waitForFile(input.go);
    io.line({ type: "second" });
    // Let a write to the closed pipe surface as a stream error before leaving.
    await Bun.sleep(100);
    return 0;
  },
};

await runWorkerMain(adapter);
