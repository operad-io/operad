/**
 * The `pool` plugin: one step, `pool/agent`, that picks a worker with room in
 * a pool, runs that worker's harness step and falls back to another worker
 * when the model is unavailable. Two counts decide whether a worker may start:
 * its own `count` in the repository and the home-wide cap on its harness.
 */

import pkg from "../package.json" with { type: "json" };
import { definePlugin, isRecord, type PluginStepResult, type StepContext, type StepRunOptions } from "@operad-io/engine";
import { reportWorkerPlaced } from "@operad-io/engine/platform";
import { join } from "node:path";
import { PlaceBook, type Claim, type Places } from "./places.ts";
import { FilePlaces } from "./shared.ts";
import {
  harnessOf,
  readResolved,
  type WorkerDefinition,
} from "./workers.ts";

export * from "./workers.ts";
export { PlaceBook, type Claim, type ClaimResult, type Places } from "./places.ts";
export { FilePlaces } from "./shared.ts";

/** The event a waiting `pool/agent` sends. */
export const WAITING_EVENT = "pool.waiting";
/** The event a `pool/agent` sends when it got a place after it had waited. */
export const ACQUIRED_EVENT = "pool.acquired";

/** The settings a config.json section may set for this plugin. */
export const POOL_SETTINGS = {
  type: "object" as const,
  properties: {
    harnesses: {
      type: "object" as const,
      additionalProperties: {
        type: "integer" as const,
        minimum: 1,
      },
      default: {},
      description:
        'How many runs through pool/agent may go at once in this home for one harness, as { "<harness plugin>": <count> }. A harness not listed has no limit. Takes effect with the next pool/agent step that starts.',
    },
  },
};

/** The settings keys, for the docs test. */
export const POOL_SETTING_NAMES: readonly string[] = Object.keys(POOL_SETTINGS.properties);

function capOf(
  settings: Readonly<Record<string, unknown>>,
  harness: string,
): number | undefined {
  const map = settings.harnesses;
  if (!isRecord(map)) return undefined;
  const cap = map[harness];
  return typeof cap === "number" ? cap : undefined;
}

/** True when the harness step reported that it could not start at all. */
export function harnessDidNotStart(data: Readonly<Record<string, unknown>> | undefined): boolean {
  return data?.reason === "missing" || data?.reason === "spawn";
}

/** True when the harness reported its model unavailable or at its usage limit. */
export function modelUnavailable(data: Readonly<Record<string, unknown>> | undefined): boolean {
  const error = data?.modelError;
  if (!isRecord(error)) return false;
  return error.kind === "unavailable" || error.kind === "usage_limit";
}

function failed(reason: string, message: string, extra: Record<string, unknown> = {}): PluginStepResult {
  return { result: "failed", data: { reason, message, ...extra } };
}

/** The params `pool/agent` reads itself; the harness step does not get them. */
const OWN_PARAMS = ["worker", "workers", "fallbacks", "prefix", "countPrefix", "holder"];

interface Place {
  readonly worker: WorkerDefinition;
  readonly release: () => Promise<void>;
}

type Attempt =
  | { readonly kind: "result"; readonly result: PluginStepResult }
  | { readonly kind: "threw"; readonly error: unknown };

export interface PoolPluginOptions {
  /**
   * Where the places live. A test passes a book to look at what is held; the
   * plugin otherwise keeps them in a file under the home, because every step
   * runs in a fresh worker thread that loads this plugin again.
   */
  readonly book?: Places | undefined;
}

export function createPoolPlugin(options: PoolPluginOptions = {}) {
  const places = (ctx: StepContext): Places =>
    options.book ?? new FilePlaces(join(ctx.home, "pool"));

  /**
   * Waits for the first of `candidates` whose own count and harness cap both
   * have room and takes its places. Undefined when the signal aborts first.
   */
  async function acquire(
    ctx: StepContext,
    prefix: string,
    candidates: readonly WorkerDefinition[],
    holder: string | undefined,
    countPrefix: string = prefix,
  ): Promise<Place | undefined> {
    const book = places(ctx);
    let announced: string | undefined;
    let announcements = 0;
    for (;;) {
      if (ctx.signal.aborted) return undefined;
      const claims: Claim[] = candidates.map((worker) => {
        const harness = harnessOf(worker.use);
        return {
          own: `count:${countPrefix}/${worker.name}`,
          ownLimit: worker.count,
          home: `harness:${harness}`,
          homeLimit: capOf(ctx.settings, harness),
          holder,
        };
      });
      const got = await book.claim(claims);
      if (got.kind === "taken") {
        const worker = candidates[got.index];
        if (worker === undefined) throw new Error("pool: a claim was taken for no worker");
        if (announced !== undefined) {
          await ctx.emit({
            type: ACQUIRED_EVENT,
            key: `${ctx.runId}:${prefix}:acquired`,
            summary: `got a place in pool ${prefix}: ${worker.name}`,
            data: { pool: prefix, worker: worker.name },
          });
        }
        return { worker, release: got.release };
      }
      const blocked = candidates.map((worker, index) => ({
        worker: worker.name,
        full: got.full[index] ?? "home",
        holders: [...(got.holders[index] ?? [])],
      }));
      const full = blocked.every((item) => item.full === "flow") ? "flow" : "home";
      const state = `${full}|${blocked.map((item) => item.holders.join(",")).join(";")}`;
      if (announced !== state) {
        announced = state;
        announcements += 1;
        const what =
          full === "flow"
            ? "the flow's count of every worker is full"
            : "the home cap of a harness is full";
        await ctx.emit({
          type: WAITING_EVENT,
          key: `${ctx.runId}:${prefix}:${full}:${announcements}`,
          summary: `waiting in pool ${prefix}: ${what}`,
          data: { pool: prefix, full, workers: blocked },
        });
      }
      if (!(await book.changed(got.stamp, ctx.signal))) return undefined;
    }
  }

  /** One run of one worker, with its places held only for the run. */
  async function attempt(
    ctx: StepContext,
    prefix: string,
    candidates: readonly WorkerDefinition[],
    input: Record<string, unknown>,
    options: StepRunOptions,
  ): Promise<
    | { readonly kind: "aborted" }
    | (Attempt & { readonly worker: WorkerDefinition })
  > {
    const holder = typeof input.holder === "string" ? input.holder : undefined;
    // A worker's count is its own, whichever pool asks for it.
    const countPrefix = typeof input.countPrefix === "string" ? input.countPrefix : prefix;
    const place = await acquire(ctx, prefix, candidates, holder, countPrefix);
    if (place === undefined) return { kind: "aborted" };
    const { worker } = place;
    reportWorkerPlaced(worker.name);
    try {
      const runStep = ctx.runStep;
      if (runStep === undefined) {
        throw new Error("the kernel did not offer a way to run the worker's harness step");
      }
      const rest: Record<string, unknown> = { ...input };
      for (const key of OWN_PARAMS) delete rest[key];
      const params = {
        ...rest,
        args: worker.args,
        ...(worker.wallTimeSecs === undefined ? {} : { wallTimeSecs: worker.wallTimeSecs }),
        ...(worker.stallSecs === undefined ? {} : { stallSecs: worker.stallSecs }),
      };
      const result = await runStep(worker.use, params, options);
      return { kind: "result", result, worker };
    } catch (error) {
      return { kind: "threw", error, worker };
    } finally {
      await place.release();
    }
  }

  return definePlugin({
    name: "pool",
    kind: "stage",
    version: pkg.version,
    settings: POOL_SETTINGS,
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        // A run waits for room and then runs an agent: as long as a harness step.
        timeoutSecs: 8 * 3600,
        async run(ctx, params): Promise<PluginStepResult> {
          const at = "pool/agent";
          if (!isRecord(params)) throw new Error(`${at}: params: must be an object`);
          const prefix = params.prefix;
          if (typeof prefix !== "string" || prefix.length === 0) {
            throw new Error(`${at}: params.prefix: must be a non-empty string`);
          }
          const workers = readResolved(params.workers, `${at}: params.workers`);
          if (workers.length === 0) {
            throw new Error(`${at}: params.workers: must list at least one worker`);
          }
          const fallbacks =
            params.fallbacks === undefined
              ? []
              : readResolved(params.fallbacks, `${at}: params.fallbacks`);
          const asked = params.worker;
          if (asked !== undefined && typeof asked !== "string") {
            throw new Error(`${at}: params.worker: must be a worker name`);
          }

          let candidates = workers;
          if (asked !== undefined) {
            candidates = workers.filter((worker) => worker.name === asked);
            if (candidates.length === 0) {
              return failed(
                "unknown_worker",
                `the worker "${asked}" is not in pool ${prefix} (${workers.map((worker) => worker.name).join(", ")})`,
                { requested: asked },
              );
            }
          }

          const options: StepRunOptions = {
            runId: ctx.runId,
            cwd: typeof params.cwd === "string" ? params.cwd : ctx.cwd,
            ...(ctx.object === undefined ? {} : { object: ctx.object }),
            params: ctx.params,
            access: ctx.access,
            ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
            signal: ctx.signal,
          };
          const interrupted = (): PluginStepResult => ({
            result: "interrupted",
            data: { reason: "cancelled", message: `stopped while waiting in pool ${prefix}` },
          });
          const record = (
            result: PluginStepResult,
            worker: WorkerDefinition,
            from: WorkerDefinition | undefined,
          ): PluginStepResult => ({
            result: result.result,
            data: {
              ...(result.data ?? {}),
              worker: worker.name,
              harness: harnessOf(worker.use),
              ...(from === undefined ? {} : { fallbackFrom: from.name }),
            },
          });

          const first = await attempt(ctx, prefix, candidates, params, options);
          if (first.kind === "aborted") return interrupted();
          const name = first.worker.fallback;
          const triggered =
            name !== undefined &&
            !ctx.signal.aborted &&
            (first.kind === "threw" ||
              modelUnavailable(first.result.data) ||
              (first.result.result === "failed" && harnessDidNotStart(first.result.data)));
          if (!triggered) {
            if (first.kind === "threw") throw first.error;
            return record(first.result, first.worker, undefined);
          }
          const target = [...workers, ...fallbacks].find((worker) => worker.name === name);
          if (target === undefined) {
            return failed(
              "unknown_fallback",
              `the fallback "${name}" of "${first.worker.name}" is not in the definitions given to pool/agent`,
              { worker: first.worker.name },
            );
          }

          // The first worker's places are already released; wait for the fallback's.
          // A session belongs to the worker that was asked for; the fallback starts its own.
          const { resumeSession: _session, ...fallbackParams } = params;
          const second = await attempt(ctx, prefix, [target], fallbackParams, options);
          if (second.kind === "aborted") return interrupted();
          if (second.kind === "threw") throw second.error;
          return record(second.result, second.worker, first.worker);
        },
      },
    ],
  });
}

export default createPoolPlugin();
