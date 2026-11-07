/**
 * The step limit of a harness `agent` step: how many runs of one model may be
 * going at once. The key is `<harness>:<model>`; the count comes from the
 * plugin setting `concurrency`, a map from model to a positive integer. A
 * model that is not in the map, or a step that names no model, has no limit.
 */

import type { StepLimitDefinition } from "@operad-io/engine";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings schema property both harnesses declare for `concurrency`. */
export const CONCURRENCY_SETTING = {
  type: "object" as const,
  default: {},
  description:
    'How many agent runs of one model may go at once, as { "<model>": <count> }. A model not listed has no limit. Takes effect with the next step that starts.',
};

/** The value of `flag` in an `args` list, or undefined when it has none. */
export function flagValue(
  args: unknown,
  flag: string,
): string | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let index = 0; index < args.length - 1; index += 1) {
    const value = args[index + 1];
    if (args[index] === flag && typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Builds the `limit` of a harness step. `modelOf` names the model one call
 * uses, from the step's params and the plugin settings, or nothing.
 */
export function modelLimit(
  harness: string,
  modelOf: (
    params: unknown,
    settings: Readonly<Record<string, unknown>>,
  ) => string | undefined,
): StepLimitDefinition {
  const countFor = (
    model: string,
    settings: Readonly<Record<string, unknown>>,
  ): number | undefined => {
    const map = settings.concurrency;
    if (map === undefined) return undefined;
    if (!isRecord(map)) {
      throw new Error("settings.concurrency: must be an object");
    }
    const count = map[model];
    if (count === undefined) return undefined;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new Error(
        `settings.concurrency: "${model}" must be a positive integer`,
      );
    }
    return count;
  };
  return {
    key: (params, settings) => {
      const model = modelOf(params, settings);
      if (model === undefined) return undefined;
      return countFor(model, settings) === undefined
        ? undefined
        : `${harness}:${model}`;
    },
    concurrent: (params, settings) => {
      const model = modelOf(params, settings);
      const count = model === undefined ? undefined : countFor(model, settings);
      if (count === undefined) {
        throw new Error("concurrent: the step has no limit");
      }
      return count;
    },
  };
}
