import { isRecord } from "@operad-io/engine";
/**
 * The worker definitions of a flow's settings: `workers` and `pools`. The
 * parser here is the one place that knows their fields, defaults and
 * refusals, so `dev` and later flows share them. `WORKER_FIELDS` and
 * `POOL_FIELDS` are the list the parser and the docs test both read.
 */

/** A worker as a flow writes it, with every default filled. */
export interface WorkerDefinition {
  readonly name: string;
  /** The harness step, `<plugin>/<step>`. */
  readonly use: string;
  readonly args: readonly string[];
  /** How many runs of this worker may go at once in one repository. */
  readonly count: number;
  readonly wallTimeSecs?: number | undefined;
  readonly stallSecs?: number | undefined;
  /** Another worker of the same set to run when this one's model fails. */
  readonly fallback?: string | undefined;
}

/** One documented field of a worker definition. */
export interface FieldInfo {
  readonly name: string;
  readonly type: string;
  /** The default as the docs print it, or `none` when the field is optional. */
  readonly default: unknown;
  readonly required: boolean;
  /** Words the docs must use for a default that is not a plain value. */
  readonly defaultText?: string | undefined;
}

/** The fields of one entry of `workers`. */
export const WORKER_FIELDS: readonly FieldInfo[] = [
  { name: "use", type: "string", default: undefined, required: true },
  { name: "args", type: "array of strings", default: [], required: false },
  { name: "count", type: "integer", default: 1, required: false },
  { name: "wallTimeSecs", type: "number", default: undefined, required: false },
  { name: "stallSecs", type: "number", default: undefined, required: false },
  { name: "fallback", type: "string", default: undefined, required: false },
];

/** The two settings of a flow that define workers. */
export const POOL_FIELDS: readonly FieldInfo[] = [
  { name: "workers", type: "object", default: undefined, required: true },
  {
    name: "pools",
    type: "object",
    default: undefined,
    required: false,
    defaultText: "one pool named `default`",
  },
];

/** The pool that exists when `pools` is absent. */
export const DEFAULT_POOL = "default";

/** A refusal of worker definitions; `field` is the path of the bad value. */
export class WorkerDefinitionError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "WorkerDefinitionError";
    this.field = field;
  }
}

function join(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new WorkerDefinitionError(field, "must be a positive number of seconds");
  }
  return value;
}

/** True when `use` is `<plugin>/<step>`. */
export function isStepName(use: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(use);
}

/** The plugin name of a `<plugin>/<step>` use. */
export function harnessOf(use: string): string {
  return use.slice(0, use.indexOf("/"));
}

/** Reads one worker; `at` is its path, such as `workers.claude`. */
export function readWorker(name: string, value: unknown, at: string): WorkerDefinition {
  if (!isRecord(value)) throw new WorkerDefinitionError(at, "must be an object");
  const known = WORKER_FIELDS.map((field) => field.name);
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new WorkerDefinitionError(`${at}.${key}`, "is not a worker field");
    }
  }
  const use = value.use;
  if (typeof use !== "string" || !isStepName(use)) {
    throw new WorkerDefinitionError(
      `${at}.use`,
      "must be a step name such as harness-claude/agent",
    );
  }
  let args: readonly string[] = [];
  if (value.args !== undefined) {
    if (!Array.isArray(value.args)) {
      throw new WorkerDefinitionError(`${at}.args`, "must be an array of strings");
    }
    args = value.args.map((item: unknown, index: number) => {
      if (typeof item !== "string") {
        throw new WorkerDefinitionError(`${at}.args[${index}]`, "must be a string");
      }
      return item;
    });
  }
  let count = 1;
  if (value.count !== undefined) {
    if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 1) {
      throw new WorkerDefinitionError(`${at}.count`, "must be an integer of 1 or more");
    }
    count = value.count;
  }
  const wallTimeSecs =
    value.wallTimeSecs === undefined
      ? undefined
      : positiveNumber(value.wallTimeSecs, `${at}.wallTimeSecs`);
  const stallSecs =
    value.stallSecs === undefined
      ? undefined
      : positiveNumber(value.stallSecs, `${at}.stallSecs`);
  let fallback: string | undefined;
  if (value.fallback !== undefined) {
    if (typeof value.fallback !== "string" || value.fallback.length === 0) {
      throw new WorkerDefinitionError(`${at}.fallback`, "must be a worker name");
    }
    fallback = value.fallback;
  }
  return {
    name,
    use,
    args,
    count,
    ...(wallTimeSecs === undefined ? {} : { wallTimeSecs }),
    ...(stallSecs === undefined ? {} : { stallSecs }),
    ...(fallback === undefined ? {} : { fallback }),
  };
}

/** The workers of a flow and its pools, parsed and checked. */
export interface ParsedWorkers {
  /** Every worker, in the order written. */
  readonly workers: readonly WorkerDefinition[];
  /** Pool name to its worker names, in order. */
  readonly pools: Readonly<Record<string, readonly string[]>>;
}

/**
 * Parses the `workers` and `pools` values of a flow's settings. `prefix` is
 * the path they sit under ("" when they are top-level fields), so a refusal
 * names `workers.claude.fallback` or `settings.workers.claude.fallback`.
 */
export function parseWorkers(
  workers: unknown,
  pools: unknown,
  prefix = "",
): ParsedWorkers {
  const workersAt = join(prefix, "workers");
  const poolsAt = join(prefix, "pools");
  if (!isRecord(workers)) throw new WorkerDefinitionError(workersAt, "must be an object");
  const list = Object.entries(workers).map(([name, value]) =>
    readWorker(name, value, `${workersAt}.${name}`),
  );
  if (list.length === 0) {
    throw new WorkerDefinitionError(workersAt, "must define at least one worker");
  }
  const byName = new Map(list.map((worker) => [worker.name, worker]));

  for (const worker of list) {
    const at = `${workersAt}.${worker.name}.fallback`;
    if (worker.fallback === undefined) continue;
    if (worker.fallback === worker.name) {
      throw new WorkerDefinitionError(at, `"${worker.name}" cannot fall back to itself`);
    }
    const target = byName.get(worker.fallback);
    if (target === undefined) {
      throw new WorkerDefinitionError(at, `"${worker.fallback}" is not a worker in ${workersAt}`);
    }
    if (target.fallback !== undefined) {
      if (target.fallback === worker.name) {
        throw new WorkerDefinitionError(
          at,
          `"${worker.name}" and "${worker.fallback}" fall back to each other`,
        );
      }
      throw new WorkerDefinitionError(
        at,
        `a fallback chain is one step: "${worker.fallback}" already has a fallback`,
      );
    }
  }

  const poolMap: Record<string, readonly string[]> = {};
  if (pools === undefined) {
    poolMap[DEFAULT_POOL] = list.map((worker) => worker.name);
  } else {
    if (!isRecord(pools)) throw new WorkerDefinitionError(poolsAt, "must be an object");
    const entries = Object.entries(pools);
    if (entries.length === 0) {
      throw new WorkerDefinitionError(poolsAt, "must define at least one pool");
    }
    for (const [pool, names] of entries) {
      const at = `${poolsAt}.${pool}`;
      if (!Array.isArray(names) || names.length === 0) {
        throw new WorkerDefinitionError(at, "must be a non-empty list of worker names");
      }
      poolMap[pool] = names.map((name: unknown, index: number) => {
        if (typeof name !== "string") {
          throw new WorkerDefinitionError(`${at}[${index}]`, "must be a worker name");
        }
        if (!byName.has(name)) {
          throw new WorkerDefinitionError(
            `${at}[${index}]`,
            `"${name}" is not a worker in ${workersAt}`,
          );
        }
        return name;
      });
    }
  }
  return { workers: list, pools: poolMap };
}

/** What a caller passes to `pool/agent` for one pool. */
export interface ResolvedPool {
  /** The pool's workers, in order: the ones `pool/agent` picks among. */
  readonly workers: readonly WorkerDefinition[];
  /** Workers outside the pool that a member's `fallback` names. */
  readonly fallbacks: readonly WorkerDefinition[];
}

/** The definitions of one pool, plus the fallback workers outside it. */
export function resolvePool(parsed: ParsedWorkers, pool: string): ResolvedPool {
  const names = parsed.pools[pool];
  if (names === undefined) {
    throw new WorkerDefinitionError(`pools.${pool}`, "no such pool");
  }
  const byName = new Map(parsed.workers.map((worker) => [worker.name, worker]));
  const members: WorkerDefinition[] = [];
  for (const name of names) {
    const worker = byName.get(name);
    if (worker !== undefined) members.push(worker);
  }
  const fallbacks: WorkerDefinition[] = [];
  for (const worker of members) {
    if (worker.fallback === undefined) continue;
    const target = byName.get(worker.fallback);
    if (
      target !== undefined &&
      !names.includes(target.name) &&
      !fallbacks.some((item) => item.name === target.name)
    ) {
      fallbacks.push(target);
    }
  }
  return { workers: members, fallbacks };
}

/**
 * Reads the list `pool/agent` receives: each entry is a worker with its
 * `name`. Same fields and refusals as `readWorker`.
 */
export function readResolved(value: unknown, at: string): readonly WorkerDefinition[] {
  if (!Array.isArray(value)) throw new WorkerDefinitionError(at, "must be a list of workers");
  const seen = new Set<string>();
  return value.map((item: unknown, index: number) => {
    const here = `${at}[${index}]`;
    if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) {
      throw new WorkerDefinitionError(`${here}.name`, "must be a worker name");
    }
    if (seen.has(item.name)) {
      throw new WorkerDefinitionError(`${here}.name`, `"${item.name}" is listed twice`);
    }
    seen.add(item.name);
    const { name, ...rest } = item;
    return readWorker(String(name), rest, here);
  });
}
