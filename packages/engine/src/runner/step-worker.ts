/**
 * Runs one plugin step in a worker thread, so the run's process can stop it
 * even when the step never yields to the event loop. The worker gets the
 * plugin specifiers and the store root, never a live registry.
 */

import { parentPort, workerData } from "node:worker_threads";
import { messageOf } from "../plugin/errors.ts";
import { FilePluginStore } from "../plugin/file-store.ts";
import { loadPlugin } from "../plugin/load.ts";
import { PluginRegistry } from "../plugin/registry.ts";
import type { PluginStepResult, RunObject } from "../plugin/types.ts";

interface StepWorkerRequest {
  readonly sources: readonly string[];
  readonly home: string;
  readonly cwd: string;
  readonly storeRoot: string;
  readonly use: string;
  readonly params: unknown;
  readonly runId: string;
  readonly object?: RunObject | undefined;
}

type StepWorkerReply =
  | { readonly ok: true; readonly result: PluginStepResult }
  | { readonly ok: false; readonly error: string };

async function main(request: StepWorkerRequest): Promise<void> {
  const definitions: unknown[] = [];
  for (const source of request.sources) {
    definitions.push(await loadPlugin(source, request.home));
  }
  const registry = new PluginRegistry(definitions, {
    home: request.home,
    cwd: request.cwd,
    store: new FilePluginStore({ root: request.storeRoot }),
    sources: request.sources,
  });

  const controller = new AbortController();
  parentPort?.on("message", (message: unknown) => {
    if (message === "abort") controller.abort();
  });

  const result = await registry.runStep(request.use, request.params, {
    runId: request.runId,
    cwd: request.cwd,
    ...(request.object === undefined ? {} : { object: request.object }),
    signal: controller.signal,
  });
  parentPort?.postMessage({ ok: true, result } satisfies StepWorkerReply);
}

const request = workerData as StepWorkerRequest;
main(request).catch((error: unknown) => {
  parentPort?.postMessage({
    ok: false,
    error: messageOf(error),
  } satisfies StepWorkerReply);
});
