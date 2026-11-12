/** Builds the engine's standard `Usage` from the counts a harness reads. */

import type { CostQuality, Usage } from "@operad-io/engine";

/** Who ran: the harness plugin and the model its step named, if it named one. */
export interface UsageSource {
  readonly harness: string;
  readonly model: string | null;
}

/** The counts as a harness reads them from its agent; an absent count is 0. */
export interface RawCounts {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cache_read?: number | undefined;
  readonly cache_write?: number | undefined;
}

/** The cost as a harness reads it; `micros` is the part of the run it priced. */
export interface RawCost {
  readonly micros: number;
  readonly incomplete?: boolean | undefined;
  readonly estimated?: boolean | undefined;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

/** A null `cost` is an unknown cost; a `micros` of 0 is a run known to be free. */
export function standardUsage(
  source: UsageSource,
  counts: RawCounts | undefined,
  cost: RawCost | null | undefined,
): Usage {
  const known =
    cost !== null &&
    cost !== undefined &&
    Number.isFinite(cost.micros) &&
    cost.micros >= 0;
  const quality: CostQuality | null = !known
    ? null
    : cost.incomplete === true
      ? "incomplete"
      : cost.estimated === true
        ? "estimated"
        : "exact";
  return {
    harness: source.harness,
    model: source.model,
    tokens: {
      input: count(counts?.input),
      output: count(counts?.output),
      cacheread: count(counts?.cache_read),
      cachewrite: count(counts?.cache_write),
    },
    costMicros: known ? Math.round(cost.micros) : null,
    costQuality: quality,
  };
}
