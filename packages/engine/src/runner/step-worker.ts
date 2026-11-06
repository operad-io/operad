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
import { SqlitePluginStore } from "../plugin/sqlite-store.ts";
import type { JsonValue } from "../log/types.ts";
import type {
  PluginStepResult,
  PluginStore,
  PluginStoreLocation,
  RunObject,
} from "../plugin/types.ts";

interface StepWorkerRequest {
  readonly sources: readonly string[];
  readonly home: string;
  readonly cwd: string;
  readonly storeRoot: string;
  /** The configured store; absent for a memory store, which cannot be shared. */
  readonly store?: PluginStoreLocation | undefined;
  readonly use: string;
  readonly params: unknown;
  readonly flowParams: JsonValue;
  readonly access?: JsonValue | undefined;
  /** The validated settings of every plugin, keyed by plugin name. */
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  readonly runId: string;
  readonly object?: RunObject | undefined;
}

type StepWorkerReply =
  | { readonly ok: true; readonly result: PluginStepResult }
  | { readonly ok: false; readonly error: string };

/** Opens the store the run configured, so a worker writes where the views read. */
function openWorkerStore(request: StepWorkerRequest): PluginStore {
  const location = request.store;
  if (location?.backend === "sqlite") {
    return new SqlitePluginStore({ root: location.root, file: location.file });
  }
  if (location?.backend === "jsonl") {
    return new FilePluginStore({ root: location.root });
  }
  return new FilePluginStore({ root: request.storeRoot });
}

async function main(request: StepWorkerRequest): Promise<void> {
  const definitions: unknown[] = [];
  for (const source of request.sources) {
    definitions.push(await loadPlugin(source, request.home));
  }
  const registry = new PluginRegistry(definitions, {
    home: request.home,
    cwd: request.cwd,
    store: openWorkerStore(request),
    sources: request.sources,
    ...(request.settings === undefined ? {} : { settings: request.settings }),
  });

  const controller = new AbortController();
  parentPort?.on("message", (message: unknown) => {
    if (message === "abort") controller.abort();
  });

  const result = await registry.runStep(request.use, request.params, {
    runId: request.runId,
    params: request.flowParams,
    cwd: request.cwd,
    access: request.access ?? null,
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
