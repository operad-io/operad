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
import type {
  AskOutcome,
  PluginStepResult,
  RunObject,
  StepAsker,
  StepLimiter,
  StepLimitRequest,
} from "../plugin/types.ts";
import type { JsonValue } from "../log/types.ts";
import { SqlitePluginStore } from "../plugin/sqlite-store.ts";
import type {
  PluginStore,
  PluginStoreLocation,
} from "../plugin/types.ts";
import type { StepEvent, TriggerView } from "../trigger/types.ts";

export interface StepWorkerRequest {
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
  readonly trigger?: TriggerView | undefined;
  readonly runId: string;
  readonly object?: RunObject | undefined;
}

/** What a worker posts to and listens to: `MessagePort` in the process entry. */
export interface StepWorkerPort {
  on(event: "message", listener: (message: unknown) => void): void;
  postMessage(message: unknown): void;
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

interface LimitAck {
  readonly kind: "limit-result";
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
}

interface GrantAck {
  readonly kind: "grant-result";
  readonly id: number;
  readonly ok: boolean;
  readonly used?: boolean | undefined;
  readonly error?: string | undefined;
}

interface AskAck {
  readonly kind: "ask-result";
  readonly id: number;
  readonly ok: boolean;
  readonly outcome?: AskOutcome | undefined;
  readonly error?: string | undefined;
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

export async function runStepWorker(
  request: StepWorkerRequest,
  parent: StepWorkerPort,
): Promise<void> {
  const definitions: unknown[] = [];
  for (const source of request.sources) {
    definitions.push(await loadPlugin(source, request.home));
  }

  const pendingAcks = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let nextEmitId = 1;
  const pendingLimits = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let nextLimitId = 1;

  /** Asks the run's process, which owns the log, for a place under a key, or to show a wait. */
  const limits: StepLimiter = {
    report: (request) =>
      hold({ use: "", key: request.key, concurrent: 0 }, true, request.ahead),
    acquire: (request) => hold(request, false),
  };
  function hold(
    request: StepLimitRequest,
    report: boolean,
    ahead?: number,
  ): Promise<() => Promise<void>> {
    const id = nextLimitId;
    nextLimitId += 1;
    const ask = new Promise<void>((resolve, reject) => {
      pendingLimits.set(id, { resolve, reject });
      parent.postMessage({
        kind: "limit",
        id,
        use: request.use,
        key: request.key,
        concurrent: request.concurrent,
        ...(report ? { report: true } : {}),
        ...(ahead === undefined ? {} : { ahead }),
      });
    });
    const cancel = (): void => parent.postMessage({ kind: "limit-cancel", id });
    request.signal?.addEventListener("abort", cancel, { once: true });
    return ask.then(
      () => {
        request.signal?.removeEventListener("abort", cancel);
        return () =>
          new Promise<void>((resolve, reject) => {
            pendingLimits.set(id, { resolve, reject });
            parent.postMessage({ kind: "limit-release", id });
          });
      },
      (error: unknown) => {
        request.signal?.removeEventListener("abort", cancel);
        throw error;
      },
    );
  }

  const pendingAsks = new Map<
    number,
    { resolve: (outcome: AskOutcome) => void; reject: (error: Error) => void }
  >();
  let nextAskId = 1;

  /** Asks the run's process, which owns the log, to put a question to a person. */
  const pendingGrants = new Map<
    number,
    { resolve: (used: boolean) => void; reject: (error: Error) => void }
  >();
  let nextGrantId = 1;

  const asker: StepAsker = {
    useGrant: (waitId) => {
      const id = nextGrantId;
      nextGrantId += 1;
      return new Promise<boolean>((resolve, reject) => {
        pendingGrants.set(id, { resolve, reject });
        parent.postMessage({ kind: "grant", id, waitId });
      });
    },
    ask: (question, signal) => {
      const id = nextAskId;
      nextAskId += 1;
      return new Promise<AskOutcome>((resolve, reject) => {
        const cancel = (): void => parent.postMessage({ kind: "ask-cancel", id });
        pendingAsks.set(id, {
          resolve: (outcome) => {
            signal?.removeEventListener("abort", cancel);
            resolve(outcome);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", cancel);
            reject(error);
          },
        });
        signal?.addEventListener("abort", cancel, { once: true });
        parent.postMessage({
          kind: "ask",
          id,
          request: {
            prompt: question.prompt,
            ...(question.choices === undefined
              ? {}
              : { choices: [...question.choices] }),
            ...(question.graceSecs === undefined
              ? {}
              : { graceSecs: question.graceSecs }),
          },
        });
      });
    },
  };

  parent.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    if ((message as { kind?: unknown }).kind === "grant-result") {
      const ack = message as GrantAck;
      const pending = pendingGrants.get(ack.id);
      if (pending === undefined) return;
      pendingGrants.delete(ack.id);
      if (ack.ok) pending.resolve(ack.used === true);
      else pending.reject(new Error(ack.error ?? "the permission was refused"));
      return;
    }
    if ((message as { kind?: unknown }).kind === "ask-result") {
      const ack = message as AskAck;
      const pending = pendingAsks.get(ack.id);
      if (pending === undefined) return;
      pendingAsks.delete(ack.id);
      if (ack.ok && ack.outcome !== undefined) pending.resolve(ack.outcome);
      else pending.reject(new Error(ack.error ?? "the question was refused"));
      return;
    }
    if ((message as { kind?: unknown }).kind === "limit-result") {
      const ack = message as LimitAck;
      const pending = pendingLimits.get(ack.id);
      if (pending === undefined) return;
      pendingLimits.delete(ack.id);
      if (ack.ok) pending.resolve();
      else pending.reject(new Error(ack.error ?? "the place was refused"));
      return;
    }
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
    const id = nextEmitId;
    nextEmitId += 1;
    return new Promise<void>((resolve, reject) => {
      pendingAcks.set(id, { resolve, reject });
      parent.postMessage({ kind: "emit", id, plugin, event });
    });
  };

  const registry = new PluginRegistry(definitions, {
    home: request.home,
    cwd: request.cwd,
    store: openWorkerStore(request),
    sources: request.sources,
    ...(request.settings === undefined ? {} : { settings: request.settings }),
  });

  const controller = new AbortController();
  parent.on("message", (message: unknown) => {
    if (message === "abort") controller.abort();
  });

  const result = await registry.runStep(request.use, request.params, {
    runId: request.runId,
    params: request.flowParams,
    cwd: request.cwd,
    access: request.access ?? null,
    ...(request.object === undefined ? {} : { object: request.object }),
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    emit,
    limits,
    asker,
    signal: controller.signal,
  });
  parent.postMessage({ kind: "result", ok: true, result } satisfies StepWorkerReply);
}

/** The process entry: one step run, with any failure reported to the parent. */
export function startStepWorker(
  request: StepWorkerRequest,
  port: StepWorkerPort,
): void {
  void runStepWorker(request, port).catch((error: unknown) => {
    port.postMessage({
      kind: "result",
      ok: false,
      error: messageOf(error),
    } satisfies StepWorkerReply);
  });
}

const port = parentPort;
if (port !== null) startStepWorker(workerData as StepWorkerRequest, port);
