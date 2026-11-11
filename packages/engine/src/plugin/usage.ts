import { isRecord } from "../util.ts";
/**
 * The standard shapes a step's data uses for what a run used and how it ended.
 * Every harness reports `usage` in the one `Usage` shape and ends in one of the
 * `END_RESULTS`, so cost, metrics and budgets read one form.
 */

/** The names a step may end with; the type, the validator and the manual read this list. */
export const END_RESULTS = [
  "done",
  "nothing",
  "failed",
  "needs_decision",
  "waiting",
  "interrupted",
] as const;

export type EndResult = (typeof END_RESULTS)[number];

export function isEndResult(value: unknown): value is EndResult {
  return typeof value === "string" && (END_RESULTS as readonly string[]).includes(value);
}

/** The token counts of a run. Counts a harness does not know are 0. */
export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheread: number;
  readonly cachewrite: number;
}

/** How far to trust a known cost: `incomplete` leaves some of the run unpriced. */
export const COST_QUALITIES = ["exact", "estimated", "incomplete"] as const;

export type CostQuality = (typeof COST_QUALITIES)[number];

/**
 * What one run used. `costMicros: null` is an unknown cost; a free run is 0.
 * `costQuality` is null exactly when the cost is unknown.
 */
export interface Usage {
  readonly harness: string;
  readonly model: string | null;
  readonly tokens: UsageTokens;
  readonly costMicros: number | null;
  readonly costQuality: CostQuality | null;
}

const TOKEN_FIELDS = ["input", "output", "cacheread", "cachewrite"] as const;

export type UsageCheck =
  | { readonly ok: true; readonly usage: Usage }
  | { readonly ok: false; readonly field: string; readonly message: string };

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Checks a value against `Usage`; a refusal names the first wrong field. */
export function validateUsage(value: unknown): UsageCheck {
  const refuse = (field: string, message: string): UsageCheck => ({
    ok: false,
    field,
    message: `usage.${field}: ${message}`,
  });
  if (!isRecord(value)) {
    return { ok: false, field: "", message: "usage: must be an object" };
  }
  if (typeof value.harness !== "string" || value.harness.length === 0) {
    return refuse("harness", "must be a non-empty string");
  }
  if (value.model !== null && typeof value.model !== "string") {
    return refuse("model", "must be a string or null");
  }
  const tokens = value.tokens;
  if (!isRecord(tokens)) return refuse("tokens", "must be an object");
  for (const name of TOKEN_FIELDS) {
    if (!isCount(tokens[name])) {
      return refuse(`tokens.${name}`, "must be a non-negative integer");
    }
  }
  if (value.costMicros !== null && !isCount(value.costMicros)) {
    return refuse("costMicros", "must be a non-negative integer or null");
  }
  if (value.costQuality !== null && !COST_QUALITIES.includes(value.costQuality as CostQuality)) {
    return refuse("costQuality", `must be ${COST_QUALITIES.join(", ")} or null`);
  }
  if ((value.costQuality === null) !== (value.costMicros === null)) {
    return refuse("costQuality", "must be null exactly when costMicros is null");
  }
  return {
    ok: true,
    usage: {
      harness: value.harness,
      model: value.model as string | null,
      tokens: {
        input: tokens.input as number,
        output: tokens.output as number,
        cacheread: tokens.cacheread as number,
        cachewrite: tokens.cachewrite as number,
      },
      costMicros: value.costMicros as number | null,
      costQuality: value.costQuality as CostQuality | null,
    },
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

/**
 * The usage in a step's data. Reads the standard `usage`, and for a fact
 * written before it existed the old fields (`usage: { input, output,
 * cache_read, cache_write }` and `cost: { micros }`). It is the only reader of
 * the old fields and nothing writes them. Returns undefined when the data
 * carries neither. A standard `usage` that is malformed gives undefined too,
 * and `onProblem` gets one line naming the field.
 */
export function readUsage(
  data: unknown,
  onProblem?: (message: string) => void,
): Usage | undefined {
  if (!isRecord(data)) return undefined;
  const usage = data.usage;
  if (isRecord(usage) && isRecord(usage.tokens)) {
    const checked = validateUsage(usage);
    if (!checked.ok) onProblem?.(checked.message);
    return checked.ok ? checked.usage : undefined;
  }
  const cost = data.cost;
  if (usage === undefined && cost === undefined) return undefined;
  const old = isRecord(usage) ? usage : {};
  const micros = isRecord(cost) ? cost.micros : undefined;
  const known = typeof micros === "number" && Number.isFinite(micros) && micros >= 0;
  const quality: CostQuality | null = !known
    ? null
    : isRecord(cost) && cost.incomplete === true
      ? "incomplete"
      : isRecord(cost) && cost.estimated === true
        ? "estimated"
        : "exact";
  return {
    harness: "unknown",
    model: null,
    tokens: {
      input: count(old.input),
      output: count(old.output),
      cacheread: count(old.cache_read),
      cachewrite: count(old.cache_write),
    },
    costMicros: known ? Math.round(micros) : null,
    costQuality: quality,
  };
}
