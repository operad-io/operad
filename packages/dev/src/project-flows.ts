/**
 * Flows a project writes in TypeScript: `.operad/flows/<name>.flow.ts`, a
 * `defineFlow` value built from dev's documented steps. dev applies the same
 * two hard rules it applies to a dev.json flow and refuses a file that breaks
 * one, or whose name dev.json also defines.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlowDefinition, StepShape } from "@operad-io/engine";
import type { DevSettings } from "./settings.ts";
import { isRecord } from "@operad-io/engine";

const FLOW_SUFFIX = ".flow.ts";

/** The directory of a repository's own flows, relative to the repository. */
export const PROJECT_FLOWS_DIR = ".operad/flows";

/** The flows a repository's `.operad/flows` gives, and the names dev refused. */
export interface ProjectFlows {
  /** Each accepted flow by name, ready to declare under its registered name. */
  readonly flows: ReadonlyMap<string, FlowDefinition>;
  /** Why a name is refused; the name starts no task. */
  readonly refused: ReadonlyMap<string, string>;
}

function useOf(step: Record<string, unknown>): string | undefined {
  if (step.kind !== "plugin" || !isRecord(step.params)) return undefined;
  return typeof step.params.use === "string" ? step.params.use : undefined;
}

function targetsOf(step: Record<string, unknown>): string[] {
  return isRecord(step.next)
    ? Object.values(step.next).filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The reason a flow breaks a hard rule, or undefined when it keeps both: the
 * step before a finished end is integrate (or the cleanup that follows it), and
 * there is at least one check, review or human step.
 */
export function flowProblem(flow: unknown): string | undefined {
  if (!isRecord(flow) || !Array.isArray(flow.steps) || typeof flow.entry !== "string") {
    return "is not a flow built with defineFlow";
  }
  const steps = flow.steps.filter(isRecord);
  const decides = steps.some((step) => {
    const use = useOf(step);
    return step.kind === "wait_person" || use === "dev/verify" || use === "dev/review";
  });
  if (!decides) return "needs at least one check, review or human step";
  if (!steps.some((step) => useOf(step) === "dev/integrate")) {
    return "has no integrate step: a change reaches main only through integrate";
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const step of steps) if (typeof step.id === "string") byId.set(step.id, step);
  const doneEnds = new Set<string>(["end"]);
  for (const step of steps) {
    if (step.kind === "end" && isRecord(step.params) && step.params.status === "done") {
      if (typeof step.id === "string") doneEnds.add(step.id);
    }
  }
  const before = (target: string): Record<string, unknown>[] =>
    steps.filter((step) => targetsOf(step).includes(target));
  for (const end of doneEnds) {
    for (const from of before(end)) {
      const use = useOf(from);
      if (use === "dev/integrate") continue;
      if (use === "dev/cleanup" && typeof from.id === "string") {
        const behind = before(from.id);
        if (behind.length > 0 && behind.every((step) => useOf(step) === "dev/integrate")) continue;
      }
      return `ends without integrate: step "${String(from.id)}" leads to the end, and only integrate may`;
    }
  }
  return undefined;
}

interface Loaded {
  readonly stamp: string;
  readonly module: unknown;
}

const imported = new Map<string, Loaded>();
let importCount = 0;

async function importFlow(path: string): Promise<unknown> {
  const info = statSync(path);
  const stamp = `${info.mtimeMs}:${info.size}`;
  const kept = imported.get(path);
  if (kept?.stamp === stamp) return kept.module;
  importCount += 1;
  const url = pathToFileURL(path);
  url.searchParams.set("operad-project-flow", String(importCount));
  const module = (await import(url.href)) as Record<string, unknown>;
  imported.set(path, { stamp, module: module.default });
  return module.default;
}

function registeredName(repository: string, name: string, steps: readonly StepShape[]): string {
  const slug = (text: string): string =>
    text.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "flow";
  const hash = createHash("sha1").update(JSON.stringify(steps)).digest("hex").slice(0, 12);
  return `dev/${slug(repository)}/${slug(name)}/${hash}`;
}

/** Loads the repository's TypeScript flows; every problem becomes a refusal. */
export async function loadProjectFlows(
  repositoryPath: string,
  repository: string,
  settings: DevSettings,
): Promise<ProjectFlows> {
  const flows = new Map<string, FlowDefinition>();
  const refused = new Map<string, string>();
  const directory = join(repositoryPath, PROJECT_FLOWS_DIR);
  if (!existsSync(directory)) return { flows, refused };
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(FLOW_SUFFIX))
    .sort();
  for (const file of files) {
    const name = file.slice(0, -FLOW_SUFFIX.length);
    const where = `${PROJECT_FLOWS_DIR}/${file}`;
    if (settings.flows[name] !== undefined) {
      refused.set(
        name,
        `flow "${name}" is defined in dev.json and in ${where}; keep one`,
      );
      continue;
    }
    let value: unknown;
    try {
      value = await importFlow(join(directory, file));
    } catch (error) {
      refused.set(
        name,
        `${where}: could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const problem = flowProblem(value);
    if (problem !== undefined) {
      refused.set(name, `${where}: ${problem}`);
      continue;
    }
    const flow = value as FlowDefinition;
    // A review step that names no grading reads the entry of this flow's name.
    const steps = flow.steps.map((step): StepShape => {
      if (useOf(step as unknown as Record<string, unknown>) !== "dev/review") return step;
      const outer = step.params as { readonly use: string; readonly params: unknown };
      const inner = isRecord(outer.params) ? outer.params : {};
      if (inner.grading !== undefined) return step;
      return { ...step, params: { ...outer, params: { ...inner, grading: name } } };
    });
    flows.set(name, { ...flow, steps, name: registeredName(repository, name, steps) });
  }
  return { flows, refused };
}
