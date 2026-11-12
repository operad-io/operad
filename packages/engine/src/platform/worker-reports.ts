/**
 * What a step that asked for a worker can learn about it while it runs: the
 * pool says when it gave the worker a place, the harness says when the worker's
 * program is running. The step that asked installs the reports around its call
 * and the two steps below it send theirs; nothing is passed down through
 * params, so a harness a flow names by data still reports.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The two things a worker run reports to the step that asked for it. */
export interface WorkerReports {
  /** The pool gave worker `name` a place. */
  readonly placed?: ((name: string) => void) | undefined;
  /** The worker's program is running. */
  readonly started?: (() => void) | undefined;
}

const current = new AsyncLocalStorage<WorkerReports>();

/** Runs `body` so the pool and the harness below it report to `reports`. */
export function withWorkerReports<T>(reports: WorkerReports, body: () => T): T {
  return current.run(reports, body);
}

/** Said by the pool when it gave worker `name` a place. */
export function reportWorkerPlaced(name: string): void {
  current.getStore()?.placed?.(name);
}

/** Said by a harness once the program that does the work is running. */
export function reportWorkerStarted(): void {
  current.getStore()?.started?.();
}
