/**
 * The times of one agent step, from the injected clock: how long the worker
 * took to become ready, how long the model then took to its first increment,
 * and the whole step. A ready line is a `session` line; a text, thinking or
 * tool increment is the first line of one of those kinds.
 */

import { isRecord, type AgentTimings, type PluginStepResult } from "@operad-io/engine";

/** The line every harness writes once its session is ready and the prompt is about to go out. */
export const READY_LINE = "session";

const INCREMENT_LINES: ReadonlySet<string> = new Set([
  "text_delta",
  "thinking_delta",
  "text_end",
  "thinking_end",
  "tool_execution_start",
  "message_end",
]);

function receivedAtOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const at = value["receivedAt"];
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** Measures one agent step from the moment it starts. */
export class StepTimings {
  private readonly startedAt: number;
  private readyAt: number | undefined;
  private firstAt: number | undefined;

  constructor(private readonly now: () => number) {
    this.startedAt = now();
  }

  /** Takes one line the host received, with its `receivedAt` when it has one. */
  line(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    const type = value["type"];
    if (typeof type !== "string") return;
    const at = receivedAtOf(value) ?? this.now();
    if (type === READY_LINE) {
      if (this.readyAt === undefined) this.readyAt = at;
      return;
    }
    if (!INCREMENT_LINES.has(type)) return;
    if (type === "message_end" && (typeof value["text"] !== "string" || value["text"].length === 0)) return;
    if (this.firstAt === undefined) this.firstAt = at;
  }

  /** The three durations, with the whole step measured now. */
  finish(): AgentTimings {
    const ready = this.readyAt;
    const first = this.firstAt;
    return {
      startToReadyMs: ready === undefined ? null : Math.max(0, ready - this.startedAt),
      readyToFirstMs:
        ready === undefined || first === undefined
          ? null
          : first >= ready
            ? first - ready
            : null,
      totalMs: Math.max(0, this.now() - this.startedAt),
    };
  }
}

/** The step's result with its timings beside its other data. */
export function withTimings(result: PluginStepResult, timings: AgentTimings): PluginStepResult {
  return { ...result, data: { ...(result.data ?? {}), timings } };
}
