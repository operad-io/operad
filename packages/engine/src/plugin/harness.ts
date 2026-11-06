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

/** The result names every harness `agent` step declares. */
export type AgentResultName = "done" | "failed" | "interrupted";

/** Usage counts a harness reports; a count it does not know is absent. */
export interface HarnessUsage {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cache_read?: number | undefined;
  readonly cache_write?: number | undefined;
}

/** A harness's cost. `null` in the facts means the cost is unknown, not zero. */
export interface HarnessCost {
  readonly micros: number;
  readonly incomplete?: boolean | undefined;
  readonly estimated?: boolean | undefined;
}

/** What every harness `agent` step records as its facts. */
export interface AgentResultData {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly sessionId: string | null;
  readonly finalMessage: string | null;
  readonly usage: HarnessUsage;
  /** Unknown cost is `null`; a known free run is `{ micros: 0 }`. */
  readonly cost: HarnessCost | null;
  /** The path of the JSONL file the harness wrote. */
  readonly log: string;
  readonly durationMs: number;
  /** Set on `failed`: which limit or condition ended the run. */
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  /** The last lines of the harness's own error output. */
  readonly stderr: readonly string[];
}
