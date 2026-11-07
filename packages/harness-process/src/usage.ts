/** Builds the engine's standard `Usage` from the counts a harness reads. */

import type { Usage } from "@operad-io/engine";

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

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

/** `costMicros` is null for an unknown cost and 0 for a run known to be free. */
export function standardUsage(
  source: UsageSource,
  counts: RawCounts | undefined,
  costMicros: number | null | undefined,
): Usage {
  return {
    harness: source.harness,
    model: source.model,
    tokens: {
      input: count(counts?.input),
      output: count(counts?.output),
      cacheread: count(counts?.cache_read),
      cachewrite: count(counts?.cache_write),
    },
    costMicros:
      typeof costMicros === "number" && Number.isFinite(costMicros) && costMicros >= 0
        ? Math.round(costMicros)
        : null,
  };
}
