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
import type { JsonValue } from "../log/types.ts";
import { SqlitePluginStore } from "../plugin/sqlite-store.ts";
import type {
  PluginStore,
  PluginStoreLocation,
} from "../plugin/types.ts";
import type { StepEvent, TriggerView } from "../trigger/types.ts";

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
  readonly trigger?: TriggerView | undefined;
  readonly runId: string;
  readonly object?: RunObject | undefined;
}

type StepWorkerReply =
  | { readonly kind: "result"; readonly ok: true; readonly result: PluginStepResult }
  | { readonly kind: "result"; readonly ok: false; readonly error: string };

interface EmitAck {
  readonly kind: "emit-result";
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
}

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

  const pendingAcks = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let nextEmitId = 1;

  parentPort?.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    if ((message as { kind?: unknown }).kind === "emit-result") {
      const ack = message as EmitAck;
      const pending = pendingAcks.get(ack.id);
      if (pending === undefined) return;
      pendingAcks.delete(ack.id);
      if (ack.ok) pending.resolve();
      else pending.reject(new Error(ack.error ?? "the event was refused"));
    }
  });

  const emit = (plugin: string, event: StepEvent): Promise<void> => {
    const port = parentPort;
    if (port === null) return Promise.reject(new Error("no event destination"));
    const id = nextEmitId;
    nextEmitId += 1;
    return new Promise<void>((resolve, reject) => {
      pendingAcks.set(id, { resolve, reject });
      port.postMessage({ kind: "emit", id, plugin, event });
    });
  };

  const registry = new PluginRegistry(definitions, {
    home: request.home,
    cwd: request.cwd,
    store: openWorkerStore(request),
    sources: request.sources,
  });

  const controller = new AbortController();
  parentPort?.on("message", (message: unknown) => {
    if (message === "abort") controller.abort();
  });

  const result = await registry.runStep(request.use, request.params, {
    runId: request.runId,
    params: request.flowParams,
    cwd: request.cwd,
    ...(request.object === undefined ? {} : { object: request.object }),
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    emit,
    signal: controller.signal,
  });
  parentPort?.postMessage({ kind: "result", ok: true, result } satisfies StepWorkerReply);
}

const request = workerData as StepWorkerRequest;
main(request).catch((error: unknown) => {
  parentPort?.postMessage({
    kind: "result",
    ok: false,
    error: messageOf(error),
  } satisfies StepWorkerReply);
});
