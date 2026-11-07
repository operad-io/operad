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

/** What one run used. `costMicros: null` is an unknown cost; a free run is 0. */
export interface Usage {
  readonly harness: string;
  readonly model: string | null;
  readonly tokens: UsageTokens;
  readonly costMicros: number | null;
}

const TOKEN_FIELDS = ["input", "output", "cacheread", "cachewrite"] as const;

export type UsageCheck =
  | { readonly ok: true; readonly usage: Usage }
  | { readonly ok: false; readonly field: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * carries neither.
 */
export function readUsage(data: unknown): Usage | undefined {
  if (!isRecord(data)) return undefined;
  const usage = data.usage;
  if (isRecord(usage) && isRecord(usage.tokens)) {
    const checked = validateUsage(usage);
    return checked.ok ? checked.usage : undefined;
  }
  const cost = data.cost;
  if (usage === undefined && cost === undefined) return undefined;
  const old = isRecord(usage) ? usage : {};
  const micros = isRecord(cost) ? cost.micros : undefined;
  return {
    harness: "unknown",
    model: null,
    tokens: {
      input: count(old.input),
      output: count(old.output),
      cacheread: count(old.cache_read),
      cachewrite: count(old.cache_write),
    },
    costMicros:
      typeof micros === "number" && Number.isFinite(micros) && micros >= 0
        ? Math.round(micros)
        : null,
  };
}
