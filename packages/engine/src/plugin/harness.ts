import type { EndResult } from "./usage.ts";
import type { Usage } from "./usage.ts";

/**
 * The harness-agnostic shape of an `agent` step and a `<harness>:prompt` flow.
 * Every harness plugin (radian, Claude Code, Codex) offers these params and
 * records these facts, so a flow written against one harness works with the
 * next. Types only: the kernel never runs a harness itself.
 */

/** The params every harness `agent` step accepts. */
export interface AgentStepParams {
  readonly prompt: string;
  readonly cwd: string;
  readonly args?: readonly string[] | undefined;
  /** Skill directories the agent is given; a harness that cannot load them lists them in the prompt. */
  readonly skills?: readonly string[] | undefined;
  /** The wall time the agent may run, in seconds. */
  readonly wallTimeSecs?: number | undefined;
  /** How long the agent may go without a new output line, in seconds. */
  readonly stallSecs?: number | undefined;
  /** Continue an earlier harness session instead of starting a new one. */
  readonly resumeSession?: string | undefined;
}

/** The fixed params of every `<harness>:prompt` flow. */
export interface PromptFlowParams {
  readonly prompt: string;
  readonly cwd: string;
  readonly args?: readonly string[] | undefined;
  /** Skill directories the agent is given; a harness that cannot load them lists them in the prompt. */
  readonly skills?: readonly string[] | undefined;
}

/** The result names a harness `agent` step declares: a subset of `EndResult`. */
export type AgentResultName = Extract<EndResult, "done" | "failed" | "interrupted">;

/** How long one agent step took to become ready, to its first increment and in all. */
export interface AgentTimings {
  /** From the step's start to the worker's `session` line; null when there was none. */
  readonly startToReadyMs: number | null;
  /** From the `session` line to the first text, thinking or tool line; null when there was none. */
  readonly readyToFirstMs: number | null;
  /** The whole step. */
  readonly totalMs: number;
}

/** What every harness `agent` step records as its facts. */
/** What a compaction of a harness session did. */
export interface AgentCompaction {
  readonly reason: "threshold" | "manual";
  /** The context before it, in tokens. */
  readonly before: number;
  /** The estimated context after it, when the harness could tell. */
  readonly after?: number | undefined;
  /** Whether a silent memory turn ran before it. */
  readonly flushed: boolean;
}

export interface AgentResultData {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly sessionId: string | null;
  readonly finalMessage: string | null;
  /** The standard usage; unknown cost is `costMicros: null`, a free run is `0`. */
  readonly usage: Usage;
  /** The path of the JSONL file the harness wrote. */
  readonly log: string;
  readonly durationMs: number;
  /** The three durations of the run, when the step measured them. */
  readonly timings?: AgentTimings | undefined;
  /**
   * The context at the end of a finished reply: `used` is the last model
   * call's input plus cache read and cache write, and `window` is the
   * model's context window when known. A harness that cannot tell leaves it
   * out, and an unknown window is left out.
   */
  readonly context?:
    | {
        readonly used: number;
        readonly window?: number | undefined;
      }
    | undefined;
  /** True when the run compacted the harness session; `compaction` says how. */
  readonly compacted?: true | undefined;
  readonly compaction?: AgentCompaction | undefined;
  /** Set on `failed`: which limit or condition ended the run. */
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  /** The last lines of the harness's own error output. */
  readonly stderr: readonly string[];
}
