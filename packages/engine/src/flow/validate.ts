import {
  END,
  type FlowDefinition,
  type StepKind,
  type StepShape,
  type StepType,
  type StepTypeRegistry,
} from "./types.ts";

/** A flow is not usable; the message names the flow, step and field. */
export class FlowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FlowError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRegistry(registry: StepTypeRegistry): readonly StepType[] {
  const entries: readonly StepType[] = Array.isArray(registry) ? registry : [registry];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !isStringArray(entry.results)
    ) {
      throw new FlowError("step type registry: each step type needs a name and a list of result names");
    }
  }
  return entries;
}

function resolveStepType(registry: readonly StepType[], use: string): StepType | undefined {
  const exact = registry.find((entry) => entry.name === use);
  if (exact !== undefined) return exact;
  const slash = use.indexOf("/");
  if (slash < 0) return undefined;
  const short = use.slice(slash + 1);
  return registry.find((entry) => entry.name === short);
}

interface CheckedStep extends StepShape {
  readonly kind: StepKind;
  readonly params: Record<string, unknown>;
  readonly results: readonly string[];
  readonly next: Readonly<Record<string, string>>;
}

function checkStep(
  raw: unknown,
  index: number,
  flowName: string,
  registry: readonly StepType[],
): CheckedStep {
  if (!isRecord(raw)) {
    throw new FlowError(`flow "${flowName}": steps[${index}]: must be a step object`);
  }
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new FlowError(`flow "${flowName}": steps[${index}]: id: must be a non-empty string`);
  }
  const at = (field: string): string => `flow "${flowName}": step "${id}": ${field}`;

  const kind = raw.kind;
  if (kind !== "plugin" && kind !== "wait_person" && kind !== "wait" && kind !== "end") {
    throw new FlowError(at(`kind: unknown step kind ${JSON.stringify(kind)}`));
  }
  if (raw.replay !== "safe" && raw.replay !== "unsafe") {
    throw new FlowError(at('replay: must be "safe" or "unsafe"'));
  }
  if (!isRecord(raw.params)) {
    throw new FlowError(at("params: must be an object"));
  }
  const params = raw.params;

  let results: readonly string[];
  switch (kind) {
    case "plugin": {
      const use = params.use;
      if (typeof use !== "string" || use.length === 0) {
        throw new FlowError(at("params.use: must name a plugin step type"));
      }
      const type = resolveStepType(registry, use);
      if (type === undefined) {
        throw new FlowError(at(`params.use: unknown plugin step type "${use}"`));
      }
      if (!hasOwn(params, "params")) {
        throw new FlowError(at("params.params: must be present, use {} when the step takes none"));
      }
      results = type.results;
      break;
    }
    case "wait_person": {
      if (typeof params.prompt !== "string" || params.prompt.length === 0) {
        throw new FlowError(at("params.prompt: must be a non-empty string"));
      }
      const choices = params.choices;
      if (!isStringArray(choices)) {
        throw new FlowError(at("params.choices: must be an array of strings"));
      }
      results = [...new Set([...choices, "interrupted"])];
      break;
    }
    case "wait": {
      const hasAfter = hasOwn(params, "afterSecs");
      const hasCheck = hasOwn(params, "check");
      if (hasAfter === hasCheck) {
        throw new FlowError(at("params: exactly one of afterSecs or check is required"));
      }
      if (hasAfter) {
        const afterSecs = params.afterSecs;
        if (typeof afterSecs !== "number" || !Number.isFinite(afterSecs) || afterSecs < 0) {
          throw new FlowError(at("params.afterSecs: must be zero or more seconds"));
        }
      } else {
        const check = params.check;
        if (typeof check !== "string" || check.length === 0) {
          throw new FlowError(at("params.check: must name a plugin step type"));
        }
        if (resolveStepType(registry, check) === undefined) {
          throw new FlowError(at(`params.check: unknown plugin step type "${check}"`));
        }
      }
      results = ["ready", "interrupted"];
      break;
    }
    case "end": {
      const status = params.status;
      if (status !== "done" && status !== "failed" && status !== "cancelled") {
        throw new FlowError(at('params.status: must be "done", "failed" or "cancelled"'));
      }
      results = [];
      break;
    }
  }

  const rawNext = raw.next;
  const next: Record<string, string> = {};
  if (rawNext !== undefined) {
    if (!isRecord(rawNext)) {
      throw new FlowError(at("next: must be an object"));
    }
    for (const [result, target] of Object.entries(rawNext)) {
      if (typeof target !== "string") {
        throw new FlowError(at(`next.${result}: must name a step or "end"`));
      }
      next[result] = target;
    }
  }

  return { id, kind, params, replay: raw.replay, results, next };
}

/**
 * Validates a flow against the four basic steps and the plugin step types the
 * caller declares. Throws `FlowError` naming the flow, step and field; returns
 * the flow when it is usable. Cycles are allowed.
 */
export function validateFlow(flow: unknown, registry: StepTypeRegistry = []): FlowDefinition {
  if (!isRecord(flow)) {
    throw new FlowError("flow: must be an object");
  }
  const name = flow.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new FlowError("flow: name: must be a non-empty string");
  }
  const entry = flow.entry;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new FlowError(`flow "${name}": entry: must be a non-empty string`);
  }
  if (!Array.isArray(flow.steps)) {
    throw new FlowError(`flow "${name}": steps: must be an array`);
  }
  const rawSteps: readonly unknown[] = flow.steps;

  const maxVisits = flow.maxVisits;
  if (
    maxVisits !== undefined &&
    (typeof maxVisits !== "number" || !Number.isInteger(maxVisits) || maxVisits < 1)
  ) {
    throw new FlowError(`flow "${name}": maxVisits: must be a positive integer`);
  }

  const stepTypes = normalizeRegistry(registry);

  const ids = new Set<string>();
  for (let index = 0; index < rawSteps.length; index += 1) {
    const raw = rawSteps[index];
    if (!isRecord(raw)) {
      throw new FlowError(`flow "${name}": steps[${index}]: must be a step object`);
    }
    const id = raw.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new FlowError(`flow "${name}": steps[${index}]: id: must be a non-empty string`);
    }
    if (id === END) {
      throw new FlowError(`flow "${name}": step "${id}": id: "end" is reserved`);
    }
    if (ids.has(id)) {
      throw new FlowError(`flow "${name}": step "${id}": id: duplicate step id "${id}"`);
    }
    ids.add(id);
  }

  if (!ids.has(entry)) {
    throw new FlowError(`flow "${name}": entry: "${entry}" is not a step`);
  }

  const steps = rawSteps.map((raw, index) => checkStep(raw, index, name, stepTypes));
  const byId = new Map(steps.map((step) => [step.id, step]));

  for (const step of steps) {
    for (const result of new Set(step.results)) {
      if (!hasOwn(step.next, result)) {
        throw new FlowError(
          `flow "${name}": step "${step.id}": next: no edge for result "${result}"`,
        );
      }
    }
    for (const [result, target] of Object.entries(step.next)) {
      if (!step.results.includes(result)) {
        throw new FlowError(
          `flow "${name}": step "${step.id}": next.${result}: "${result}" is not a result of this step`,
        );
      }
      if (target !== END && !ids.has(target)) {
        throw new FlowError(
          `flow "${name}": step "${step.id}": next.${result}: "${target}" is not a step`,
        );
      }
    }
  }

  const reachable = new Set<string>();
  const queue: string[] = [entry];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    const step = byId.get(id);
    if (step === undefined) continue;
    for (const target of Object.values(step.next)) {
      if (target !== END && !reachable.has(target)) queue.push(target);
    }
  }
  for (const step of steps) {
    if (!reachable.has(step.id)) {
      throw new FlowError(
        `flow "${name}": step "${step.id}": id: step is unreachable from entry "${entry}"`,
      );
    }
  }

  return maxVisits === undefined
    ? { name, entry, steps }
    : { name, entry, maxVisits, steps };
}
