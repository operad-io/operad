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
}

/** The result names a harness `agent` step declares: a subset of `EndResult`. */
export type AgentResultName = Extract<EndResult, "done" | "failed" | "interrupted">;

/** What every harness `agent` step records as its facts. */
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
  /** Set on `failed`: which limit or condition ended the run. */
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  /** The last lines of the harness's own error output. */
  readonly stderr: readonly string[];
}
