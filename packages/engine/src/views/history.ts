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

    case "grant_used":
      return {
        time,
        step,
        what: "let one call through that you approved",
        why: text(payload.value) ?? "",
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

/** Results that mean "carry on with the next step"; they need no explaining. */
const PLAIN_RESULTS: ReadonlySet<string> = new Set([
  "ready",
  "done",
  "ok",
  "pass",
  "passed",
  "success",
  "next",
]);

const SHORT_DETAIL = 100;

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** HH:MM:SS in the time zone of the host that serves the view. */
export function localTime(time: number): string {
  const date = new Date(time);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** HH:MM, for a run's heading. */
export function localMinute(time: number): string {
  return localTime(time).slice(0, 5);
}

/** YYYY-MM-DD in the host's time zone. */
export function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** 1s, 58s, 41m, 2h 5m, 3d. */
export function shortDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function oneLine(value: string, full: boolean): string {
  const flat = value.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim();
  if (full || flat.length <= SHORT_DETAIL) return flat;
  return `${flat.slice(0, SHORT_DETAIL - 1).trimEnd()}…`;
}

interface Attempt {
  readonly time: number;
  readonly step: string;
  readonly attempt: number;
  readonly reason: string;
  outcome: string | undefined;
  endedAt: number | undefined;
  detail: string;
}

type Item = Attempt | { readonly time: number; readonly text: string };

function isAttempt(item: Item): item is Attempt {
  return "attempt" in item;
}

export interface RunHistoryOptions {
  /** The current time, for a step that is still running. */
  readonly now: number;
  /** Keep every detail whole instead of cutting it to one short line. */
  readonly full: boolean;
}

/**
 * One line per step attempt, with a date line where the day changes. The
 * lines are plain text; a caller adds the list marks it needs.
 */
export function runHistoryLines(
  facts: readonly HistoryFact[],
  options: RunHistoryOptions,
): string[] {
  const items: Item[] = [];
  let open: Attempt | undefined;
  let reason = "";

  const close = (outcome: string, at: number, detail: string): void => {
    if (open === undefined) return;
    if (open.outcome === undefined || open.outcome === "waiting") {
      open.outcome = outcome;
      open.endedAt = at;
      open.detail = detail;
    }
    open = undefined;
  };

  for (const fact of facts) {
    const payload = record(fact.payload);
    switch (fact.kind) {
      case "run_started": // the run's heading says it
      case "step_started":
      case "step_slot":
      case "step_released":
      case "effect_requested":
        break;
      case "step_entered": {
        const step = text(payload.step) ?? "a step";
        const attempt: Attempt = {
          time: fact.time,
          step,
          attempt: number(payload.visit) ?? 1,
          reason,
          outcome: undefined,
          endedAt: undefined,
          detail: "",
        };
        reason = "";
        open = attempt;
        items.push(attempt);
        break;
      }
      case "step_result":
        close(text(payload.result) ?? "finished", fact.time, reasonOf(record(payload.data)));
        break;
      case "waiting_for_person":
        if (open !== undefined && open.outcome === undefined) {
          open.outcome = "waiting";
          open.detail = text(payload.prompt) ?? "";
        } else if (open === undefined) {
          const entry = historyEntry(fact);
          items.push({ time: fact.time, text: `${entry.what}: ${oneLine(entry.why, options.full)}` });
        }
        break;
      case "edge_taken": {
        const result = text(payload.result);
        if (open !== undefined) close(result ?? "finished", fact.time, "");
        reason = result === undefined || PLAIN_RESULTS.has(result) ? "" : `after ${result}`;
        break;
      }
      case "step_interrupted": {
        const entry = historyEntry(fact);
        close("interrupted", fact.time, entry.why);
        break;
      }
      case "run_ended": {
        const entry = historyEntry(fact);
        const status = text(payload.status) ?? "ended";
        close(status === "done" ? "stopped" : status, fact.time, "");
        items.push({ time: fact.time, text: `${entry.what}${entry.why.length > 0 ? `: ${entry.why}` : ""}` });
        break;
      }
      default: {
        const entry = historyEntry(fact);
        items.push({
          time: fact.time,
          text: `${entry.what}${entry.why.length > 0 ? `: ${oneLine(entry.why, options.full)}` : ""}`,
        });
      }
    }
  }

  const lines: string[] = [];
  let day = "";
  for (const item of items) {
    const today = localDay(item.time);
    if (today !== day) {
      day = today;
      lines.push(`**${today}**`);
    }
    if (!isAttempt(item)) {
      lines.push(`${localTime(item.time)}  ${item.text}`);
      continue;
    }
    const outcome = item.outcome ?? "running";
    const end = item.endedAt ?? options.now;
    const parts = [localTime(item.time), item.step];
    if (item.attempt > 1) parts.push(`attempt ${item.attempt}`);
    if (item.reason.length > 0) parts.push(item.reason);
    parts.push(outcome, shortDuration(end - item.time));
    if (item.detail.length > 0) parts.push(oneLine(item.detail, options.full));
    lines.push(parts.join("  "));
  }
  return lines;
}
