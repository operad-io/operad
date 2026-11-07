/** The history view: one line per recorded step, in order, in words. */

import type { JsonValue } from "../log/types.ts";
import type { Actor } from "../plugin/types.ts";

/** The facts a history entry needs; run facts and global facts both fit. */
export interface HistoryFact {
  readonly kind: string;
  readonly payload: JsonValue;
  readonly time: number;
}

export interface HistoryEntry {
  readonly time: number;
  readonly step: string | null;
  readonly what: string;
  readonly why: string;
  /** Who answered, when a person did. */
  readonly actor?: Actor | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function reasonOf(data: Record<string, unknown>): string {
  const message = text(data.message) ?? text(data.error);
  const reason = text(data.reason);
  const log = text(data.log) ?? text(data.path);
  let why = message ?? reason ?? "";
  if (log !== undefined) {
    why = why.length > 0 ? `${why}, log at ${log}` : `log at ${log}`;
  }
  return why;
}

/**
 * Turns facts into user words. Nothing here prints a fact kind, an effect, a
 * node, a graph or a decision; those are internal names.
 */
export function historyEntry(fact: HistoryFact): HistoryEntry {
  const payload = record(fact.payload);
  const step = text(payload.step) ?? null;
  const time = fact.time;

  switch (fact.kind) {
    case "run_started": {
      const flow = text(payload.flow) ?? "unknown";
      const trigger = record(payload.trigger);
      const source = text(trigger.source);
      const type = text(trigger.type);
      const why =
        source !== undefined && type !== undefined
          ? `flow "${flow}", started by ${source} ${type}`
          : `flow "${flow}"`;
      return {
        time,
        step,
        what: "run started",
        why,
      };
    }

    case "step_entered":
      return {
        time,
        step,
        what: `started ${step ?? "a step"}`,
        why: `attempt ${number(payload.visit) ?? 1}`,
      };

    case "effect_requested": {
      if (payload.recovery === true) {
        return {
          time,
          step,
          what: `re-running ${step ?? "the step"} after a crash`,
          why: "",
        };
      }
      const kind = text(payload.effect);
      if (kind === "schedule_wake") {
        const due = number(payload.due);
        return {
          time,
          step,
          what: `waiting for ${step ?? "the step"}`,
          why: due === undefined ? "" : `until ${iso(due)}`,
        };
      }
      if (kind === "poll_check") {
        return {
          time,
          step,
          what: `checking ${step ?? "the step"}`,
          why: "",
        };
      }
      return {
        time,
        step,
        what: `running ${step ?? "the step"}`,
        why: "",
      };
    }

    case "step_result": {
      const result = text(payload.result) ?? "finished";
      const data = record(payload.data);
      return {
        time,
        step,
        what: `${step ?? "the step"} ${result}`,
        why: reasonOf(data),
      };
    }

    case "step_queued":
      return {
        time,
        step,
        what: `${step ?? "the step"} is queued`,
        why: `waiting for a place under ${text(payload.key) ?? "its limit"}`,
      };

    case "edge_taken": {
      const target = text(payload.target) ?? "the next step";
      return {
        time,
        step,
        what: target === "end" ? "moving to the end" : `moving to ${target}`,
        why: text(payload.result) === undefined ? "" : `after ${text(payload.result) ?? ""}`,
      };
    }

    case "waiting_for_person":
      return {
        time,
        step,
        what: "waiting for you",
        why: text(payload.prompt) ?? "",
      };

    case "person_answered": {
      const actorValue = record(payload.actor);
      const via = text(actorValue.via);
      const id = text(actorValue.id);
      const whyParts: string[] = [];
      const note = text(payload.note);
      if (note !== undefined) whyParts.push(note);
      if (via !== undefined) whyParts.push(`via ${via}`);
      if (id !== undefined) whyParts.push(`as ${id}`);
      return {
        time,
        step,
        what: `you chose ${text(payload.choice) ?? "an answer"}`,
        why: whyParts.join(", "),
        ...(via === undefined || id === undefined
          ? {}
          : { actor: { via, id } }),
      };
    }

    case "ask_opened":
      return {
        time,
        step: text(payload.step) ?? step,
        what: "asked you",
        why: text(payload.prompt) ?? "",
      };

    case "ask_answered": {
      const actorValue = record(payload.actor);
      const via = text(actorValue.via);
      const id = text(actorValue.id);
      const whyParts: string[] = [];
      const note = text(payload.note);
      if (note !== undefined) whyParts.push(note);
      if (via !== undefined) whyParts.push(`via ${via}`);
      if (id !== undefined) whyParts.push(`as ${id}`);
      return {
        time,
        step,
        what: `you chose ${text(payload.choice) ?? "an answer"}`,
        why: whyParts.join(", "),
        ...(via === undefined || id === undefined
          ? {}
          : { actor: { via, id } }),
      };
    }

    case "ask_timed_out":
      return {
        time,
        step,
        what: "nobody answered in time",
        why: "",
      };

    case "ask_refused":
      return {
        time,
        step,
        what: "an answer was refused",
        why: [text(payload.choice), text(payload.reason)]
          .filter((part): part is string => part !== undefined)
          .join(": "),
      };

    case "run_ended": {
      const status = text(payload.status) ?? "ended";
      const words =
        status === "done" ? "run done" : status === "cancelled" ? "run cancelled" : "run failed";
      return { time, step, what: words, why: text(payload.reason) ?? "" };
    }

    case "step_interrupted": {
      const reason = text(payload.reason);
      const why =
        reason === "recover_unsafe"
          ? "the run stopped and this step cannot be replayed safely"
          : reason === "undeclared_result"
            ? `the step returned "${text(payload.result) ?? "an unknown result"}", which the flow does not expect${
                text(payload.message) === undefined ? "" : `: ${text(payload.message)}`
              }`
            : "the step did not finish";
      return { time, step, what: `${step ?? "the step"} interrupted`, why };
    }

    case "crash_loop_stopped":
      return {
        time,
        step,
        what: `${step ?? "the step"} keeps crashing`,
        why: `waiting for you after ${number(payload.recoveries) ?? 0} attempts`,
      };

    case "trigger_received": {
      const source = text(payload.source) ?? "an outside source";
      const type = text(payload.type) ?? "event";
      return {
        time,
        step,
        what: `event ${type} from ${source}`,
        why: text(payload.summary) ?? text(payload.link) ?? "recorded while the run was active",
      };
    }

    case "trigger_observed": {
      const flow = text(payload.flow) ?? "a flow";
      const object = text(payload.object) ?? "an object";
      return {
        time,
        step,
        what: `would start ${flow} on ${object}`,
        why: "",
      };
    }

    case "trigger_skipped": {
      const source = text(payload.source) ?? "an outside source";
      const type = text(payload.type) ?? "event";
      return {
        time,
        step,
        what: `event ${type} from ${source} not started`,
        why: text(payload.reason) ?? "the chain is too deep",
      };
    }

    case "visit_limit_reached":
      return {
        time,
        step,
        what: `${step ?? "the step"} ran too many times`,
        why: `limit ${number(payload.limit) ?? 0}`,
      };

    default:
      return { time, step, what: "something happened", why: "" };
  }
}

/** Formats one entry for a terminal: time, what happened, and why. */
export function formatHistoryEntry(entry: HistoryEntry): string {
  const why = entry.why.length > 0 ? `: ${entry.why}` : "";
  return `${iso(entry.time)}  ${entry.what}${why}`;
}

export async function* historyEntries(
  facts: AsyncIterable<HistoryFact>,
): AsyncGenerator<HistoryEntry> {
  for await (const fact of facts) {
    // Where a step runs is kernel bookkeeping; history shows what it did.
    if (
      fact.kind === "step_started" ||
      fact.kind === "step_slot" ||
      fact.kind === "step_released"
    ) {
      continue;
    }
    yield historyEntry(fact);
  }
}
