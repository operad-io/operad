/**
 * Step limits: at most `concurrent` running steps per key in one operad home.
 *
 * The facts of the runs are the only record. A step writes `step_queued`
 * before it waits and `step_slot` is written when its place is granted; the
 * place is held until the step's effect has a result (or is interrupted or
 * abandoned) or the run ends. A step that a step starts through `ctx.runStep`
 * has an effect id of its own, `<outer effect id>#<n>`, and gives its place
 * back with `step_released`. Nothing is kept in memory: every grant rebuilds
 * the held places and the queues from the logs, so a restart loses nothing.
 */

import { evolve, initialState } from "../kernel/index.ts";
import type { KernelState } from "../kernel/types.ts";
import { SeqConflictError } from "../log/errors.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { StepLimiter, StepLimitRequest } from "../plugin/types.ts";
import { withLockFile } from "../platform/index.ts";
import { join } from "node:path";

/** How often a waiting step looks again when no change was announced. */
const RECHECK_MS = 1000;

/** One step that holds a place under a key or waits for one. */
export interface LimitEntry {
  readonly runId: string;
  readonly effectId: string;
  readonly step: string | null;
  readonly key: string;
  readonly concurrent: number;
  /** When and where `step_queued` was written; this orders each queue. */
  readonly time: number;
  readonly seq: number;
  readonly granted: boolean;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The effect id of the step that a nested effect id belongs to. */
function outerOf(effectId: string): string {
  const hash = effectId.indexOf("#");
  return hash < 0 ? effectId : effectId.slice(0, hash);
}

/** The live entries of one run: places held and places waited for. */
async function scanRun(
  log: LogBackend,
  runId: string,
): Promise<{ readonly entries: LimitEntry[]; readonly lastSeq: number }> {
  let state: KernelState = initialState();
  const found = new Map<string, LimitEntry & { released: boolean }>();
  let lastSeq = 0;
  for await (const fact of log.read(runId)) {
    state = evolve(state, fact);
    lastSeq = fact.seq;
    if (
      fact.kind !== "step_queued" &&
      fact.kind !== "step_slot" &&
      fact.kind !== "step_released"
    ) {
      continue;
    }
    const payload = fact.payload;
    if (!isRecord(payload) || typeof payload.effectId !== "string") continue;
    const effectId = payload.effectId;
    const existing = found.get(effectId);
    if (fact.kind === "step_queued") {
      // A queue entry that was released is over; queueing again starts afresh.
      if (existing !== undefined && !existing.released) continue;
      if (typeof payload.key !== "string") continue;
      if (typeof payload.concurrent !== "number") continue;
      found.set(effectId, {
        runId,
        effectId,
        step: typeof payload.step === "string" ? payload.step : null,
        key: payload.key,
        concurrent: payload.concurrent,
        time: fact.time,
        seq: fact.seq,
        granted: false,
        released: false,
      });
    } else if (existing !== undefined) {
      found.set(
        effectId,
        fact.kind === "step_slot"
          ? { ...existing, granted: true }
          : { ...existing, released: true },
      );
    }
  }
  const entries: LimitEntry[] = [];
  for (const entry of found.values()) {
    if (entry.released) continue;
    if (state.effects[outerOf(entry.effectId)] !== "outstanding") continue;
    entries.push({
      runId: entry.runId,
      effectId: entry.effectId,
      step: entry.step,
      key: entry.key,
      concurrent: entry.concurrent,
      time: entry.time,
      seq: entry.seq,
      granted: entry.granted,
    });
  }
  return { entries, lastSeq };
}

/** Every live entry of every active run. */
export async function scanLimits(log: LogBackend): Promise<LimitEntry[]> {
  const all: LimitEntry[] = [];
  for (const run of await log.runs({ active: true })) {
    try {
      all.push(...(await scanRun(log, run.runId)).entries);
    } catch {
      // A run that cannot be read holds nothing; its own runner reports it.
    }
  }
  return all;
}

function compareQueue(left: LimitEntry, right: LimitEntry): number {
  if (left.time !== right.time) return left.time - right.time;
  if (left.runId !== right.runId) return left.runId < right.runId ? -1 : 1;
  return left.seq - right.seq;
}

/** The queued entries of one key, first in line first. */
export function queueOf(
  entries: readonly LimitEntry[],
  key: string,
): LimitEntry[] {
  return entries
    .filter((entry) => entry.key === key && !entry.granted)
    .sort(compareQueue);
}

/** For each run with a queued step: its key and how many are ahead of it. */
export async function queuedSteps(
  log: LogBackend,
): Promise<Map<string, { readonly key: string; readonly ahead: number }>> {
  const entries = await scanLimits(log);
  const result = new Map<string, { readonly key: string; readonly ahead: number }>();
  for (const key of new Set(entries.map((entry) => entry.key))) {
    queueOf(entries, key).forEach((entry, ahead) => {
      if (!result.has(entry.runId)) result.set(entry.runId, { key, ahead });
    });
  }
  return result;
}

export interface StepLimitsOptions {
  readonly log: LogBackend;
  /** The store root; the grant lock lives under `<root>/locks`. */
  readonly lockRoot?: string | undefined;
  readonly clock?: (() => number) | undefined;
}

/** Serializes grants made inside one process that has no lock root. */
const localTails = new WeakMap<LogBackend, Promise<unknown>>();

export interface LimitClaim {
  readonly runId: string;
  readonly effectId: string;
  readonly step: string | null;
  readonly key: string;
  readonly concurrent: number;
}

export class StepLimits {
  private readonly log: LogBackend;
  private readonly lockRoot: string | undefined;

  constructor(options: StepLimitsOptions) {
    this.log = options.log;
    this.lockRoot = options.lockRoot;
  }

  /**
   * Takes a place for the claim: writes `step_queued` unless the run already
   * has it, then waits until `step_slot` is written. A step whose place was
   * granted before a crash returns at once. An abort stops the wait and
   * releases the claim.
   */
  async acquire(claim: LimitClaim, signal?: AbortSignal): Promise<void> {
    const own = await scanRun(this.log, claim.runId);
    const have = own.entries.find((entry) => entry.effectId === claim.effectId);
    if (have === undefined) {
      await this.appendFact(claim.runId, "step_queued", {
        step: claim.step,
        effectId: claim.effectId,
        key: claim.key,
        concurrent: claim.concurrent,
      });
    }
    if (have?.granted === true) return;

    for (;;) {
      if (signal?.aborted === true) {
        await this.release(claim);
        throw new Error("the step was cancelled while it waited for a place");
      }
      await this.grant();
      const now = await scanRun(this.log, claim.runId);
      if (
        now.entries.some(
          (entry) => entry.effectId === claim.effectId && entry.granted,
        )
      ) {
        return;
      }
      await this.changed(signal);
    }
  }

  /** Gives a claim's place back, or leaves the queue. */
  async release(claim: LimitClaim): Promise<void> {
    const own = await scanRun(this.log, claim.runId);
    if (own.entries.some((entry) => entry.effectId === claim.effectId)) {
      await this.appendFact(claim.runId, "step_released", {
        effectId: claim.effectId,
        key: claim.key,
      });
    }
    await this.grant();
  }

  /**
   * Gives back every place that steps of this effect still hold (after a crash
   * the process that held them is gone) and returns the highest number a
   * nested step of this effect used, so new ones never reuse an id.
   */
  async resetNested(runId: string, effectId: string): Promise<number> {
    const own = await scanRun(this.log, runId);
    let highest = 0;
    for (const entry of own.entries) {
      if (outerOf(entry.effectId) !== effectId || entry.effectId === effectId) {
        continue;
      }
      await this.appendFact(runId, "step_released", {
        effectId: entry.effectId,
        key: entry.key,
      });
    }
    // Ids are never reused, released or not.
    for await (const fact of this.log.read(runId)) {
      if (fact.kind !== "step_queued" || !isRecord(fact.payload)) continue;
      const id = fact.payload.effectId;
      if (typeof id !== "string" || outerOf(id) !== effectId) continue;
      const suffix = Number(id.slice(effectId.length + 1));
      if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
    }
    return highest;
  }

  /**
   * Grants every place that is free to the first in line of its key. It is the
   * only writer of `step_slot`, and it runs under one lock for the home.
   */
  async grant(): Promise<void> {
    await this.locked(async () => {
      const entries = await scanLimits(this.log);
      for (const key of new Set(entries.map((entry) => entry.key))) {
        let held = entries.filter(
          (entry) => entry.key === key && entry.granted,
        ).length;
        for (const next of queueOf(entries, key)) {
          if (held >= next.concurrent) break;
          await this.appendFact(next.runId, "step_slot", {
            step: next.step,
            effectId: next.effectId,
            key,
          });
          held += 1;
        }
      }
    });
  }

  /** A `StepLimiter` for the steps that the step of `effectId` starts. */
  limiterFor(
    runId: string,
    effectId: string,
    step: string | null,
    firstNumber: number,
  ): StepLimiter {
    let next = firstNumber;
    return {
      acquire: async (request: StepLimitRequest) => {
        next += 1;
        const claim: LimitClaim = {
          runId,
          effectId: `${effectId}#${next}`,
          step,
          key: request.key,
          concurrent: request.concurrent,
        };
        await this.acquire(claim, request.signal);
        return () => this.release(claim);
      },
    };
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    if (this.lockRoot !== undefined) {
      return withLockFile(join(this.lockRoot, "locks", "limits.lock"), work, {
        label: "limits",
        onLog: () => undefined,
      });
    }
    const tail = localTails.get(this.log) ?? Promise.resolve();
    const run = tail.then(work, work);
    localTails.set(
      this.log,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Appends one fact to a run, following the run's own writes. */
  private async appendFact(
    runId: string,
    kind: "step_queued" | "step_slot" | "step_released",
    payload: Record<string, JsonValue>,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      let lastSeq = 0;
      for await (const fact of this.log.read(runId)) lastSeq = fact.seq;
      try {
        await this.log.append(runId, lastSeq, [
          { kind, payload, cause: lastSeq },
        ]);
        return;
      } catch (error) {
        if (error instanceof SeqConflictError && attempt < 5) continue;
        throw error;
      }
    }
  }

  /** Resolves on the next change to any run, a recheck tick, or an abort. */
  private changed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe?.();
        signal?.removeEventListener("abort", done);
        resolve();
      };
      unsubscribe = this.log.subscribe?.(done);
      timer = setTimeout(done, RECHECK_MS);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
