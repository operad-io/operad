import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
  type PluginStepResult,
  type StepEvent,
} from "@operad-io/engine";
import { PlaceBook, createPoolPlugin, type WorkerDefinition } from "../src/index.ts";

const roots: string[] = [];

export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "pool-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}

/** One call of a fake harness step, waiting for the test to end it. */
export interface HarnessCall {
  readonly use: string;
  readonly params: Record<string, unknown>;
  finish(result: PluginStepResult): void;
  fail(error: Error): void;
}

/** A queue the test can wait on: no polling, no sleeping. */
export class Queue<T> {
  private readonly items: T[] = [];
  private readonly takers: ((item: T) => void)[] = [];
  push(item: T): void {
    const taker = this.takers.shift();
    if (taker !== undefined) taker(item);
    else this.items.push(item);
  }
  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.takers.push(resolve));
  }
  get length(): number {
    return this.items.length;
  }
}

/** A harness plugin whose `agent` step waits until the test ends the call. */
export function fakeHarness(name: string, calls: Queue<HarnessCall>) {
  return definePlugin({
    name,
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        run(_ctx, params) {
          return new Promise<PluginStepResult>((resolve, reject) => {
            calls.push({
              use: `${name}/agent`,
              params: params as Record<string, unknown>,
              finish: resolve,
              fail: reject,
            });
          });
        },
      },
    ],
  });
}

export interface Rig {
  readonly registry: PluginRegistry;
  readonly book: PlaceBook;
  readonly calls: Queue<HarnessCall>;
  readonly events: Queue<StepEvent>;
  run(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PluginStepResult>;
}

/** Harness names the rig defines; `pool` uses `harness-a` and `harness-b`. */
export async function rig(
  settings: Record<string, unknown> = {},
  shared?: { readonly book: PlaceBook; readonly calls: Queue<HarnessCall> },
  /** When given, an event is delivered only after this resolves. */
  eventGate?: Promise<void>,
): Promise<Rig> {
  const root = await tempRoot();
  const book = shared?.book ?? new PlaceBook();
  const calls = shared?.calls ?? new Queue<HarnessCall>();
  const events = new Queue<StepEvent>();
  const registry = new PluginRegistry(
    [
      createPoolPlugin({ book }),
      fakeHarness("harness-a", calls),
      fakeHarness("harness-b", calls),
    ],
    {
      home: join(root, "home"),
      cwd: root,
      store: new MemoryPluginStore({ root: join(root, "store") }),
      settings: { pool: settings },
      onLog: () => undefined,
    },
  );
  let counter = 0;
  return {
    registry,
    book,
    calls,
    events,
    run(params, signal) {
      counter += 1;
      return Promise.resolve(
        registry.runStep("pool/agent", params, {
          runId: `run-${counter}`,
          signal,
          emit: async (_plugin, event) => {
            if (eventGate !== undefined) await eventGate;
            events.push(event);
          },
        }),
      );
    },
  };
}

export function worker(
  name: string,
  use: string,
  extra: Partial<WorkerDefinition> = {},
): WorkerDefinition {
  return { name, use, args: [], count: 1, ...extra };
}

export const done: PluginStepResult = { result: "done", data: {} };
