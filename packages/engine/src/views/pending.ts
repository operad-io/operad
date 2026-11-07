/** The pending view: every run waiting for a person, with what can be done. */

import { objectLink } from "../http/link.ts";
import type { LogBackend, RunInfo } from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { PendingActionView } from "../plugin/types.ts";
import { answerableAsks, scanAsks } from "../runner/ask.ts";
import { parseObjectKey, readState } from "../runner/service.ts";
import type { TriggerCandidate } from "../trigger/types.ts";

/** Where the pending view gets candidates the kernel derived from the log. */
export interface CandidateSource {
  candidates(): Promise<readonly TriggerCandidate[]> | readonly TriggerCandidate[];
}

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
  /** The object the run is about, as `<type>:<id>`; absent for a candidate. */
  readonly object?: string;
  /** The link that opens the object in the app; absent for a candidate. */
  readonly link?: string;
}

/** Runs waiting for a person, in the order they started. */
export async function listPending(
  log: LogBackend,
  registry: PluginRegistry,
  triggers?: CandidateSource,
): Promise<readonly PendingItem[]> {
  const runs = (await log.runs({ active: true })).sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const items: PendingItem[] = [];

  for (const run of runs) {
    const state = await readState(log, run.runId);
    if (state.status === "running") {
      // A step waiting on its own question is one item, like a flow wait.
      const { asks } = await scanAsks(log, run.runId);
      const open = answerableAsks(asks, state).at(-1);
      if (open !== undefined) {
        items.push({
          runId: run.runId,
          flow: run.flow,
          step: state.step,
          prompt: open.prompt,
          choices: open.choices,
          actions: await actionsFor(registry, log, run),
          kind: "run",
          ...objectFields(run.object),
        });
      }
      continue;
    }
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
      ...objectFields(run.object),
    });
  }

  const candidates =
    triggers === undefined ? [] : await triggers.candidates();
  for (const candidate of candidates) {
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

function objectFields(
  key: string,
): { readonly object: string; readonly link: string } | Record<string, never> {
  const object = parseObjectKey(key);
  if (object === undefined) return {};
  return {
    object: `${object.type}:${object.id}`,
    link: objectLink(object.type, object.id),
  };
}
