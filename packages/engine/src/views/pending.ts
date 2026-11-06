/** The pending view: every run waiting for a person, with what can be done. */

import type { LogBackend, RunInfo } from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { PendingActionView } from "../plugin/types.ts";
import { parseObjectKey, readState } from "../runner/service.ts";
import type { TriggerStore } from "../trigger/store.ts";

export interface PendingItem {
  /** A run id, or the pending id of a candidate event. */
  readonly runId: string;
  readonly flow: string;
  readonly step: string | null;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly actions: readonly PendingActionView[];
  readonly kind?: "run" | "candidate";
  readonly pendingId?: string;
}

/** Runs waiting for a person, in the order they started. */
export async function listPending(
  log: LogBackend,
  registry: PluginRegistry,
  triggers?: TriggerStore,
): Promise<readonly PendingItem[]> {
  const runs = (await log.runs({ active: true })).sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const items: PendingItem[] = [];

  for (const run of runs) {
    const state = await readState(log, run.runId);
    if (state.status !== "waiting_person" || state.wait === null) continue;

    const actions = await actionsFor(registry, log, run);
    items.push({
      runId: run.runId,
      flow: run.flow,
      step: state.step,
      prompt: state.wait.prompt,
      choices: state.wait.choices,
      actions,
      kind: "run",
    });
  }

  for (const candidate of triggers?.candidates() ?? []) {
    items.push({
      runId: candidate.pendingId,
      flow: candidate.flow,
      step: null,
      prompt: `would start ${candidate.flow} on ${candidate.object}`,
      choices: [],
      actions: [
        { plugin: "operad", action: "start" },
        { plugin: "operad", action: "dismiss" },
      ],
      kind: "candidate",
      pendingId: candidate.pendingId,
    });
  }

  return items;
}

async function actionsFor(
  registry: PluginRegistry,
  _log: LogBackend,
  run: RunInfo,
): Promise<readonly PendingActionView[]> {
  const object = parseObjectKey(run.object);
  if (object === undefined) return [];
  const entry = await registry.store.get(object.type, object.id);
  if (entry === undefined) return [];
  const pending = await registry.pending([
    {
      runId: run.runId,
      object: { type: object.type, id: object.id },
    },
  ]);
  return pending[0]?.actions ?? [];
}
