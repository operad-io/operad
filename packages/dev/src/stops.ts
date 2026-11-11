/**
 * Tells a step that stopped because of operad or the machine from one that
 * stopped because of the task's own work. It reads structured data only: the
 * result the flow took, the reason dev recorded, the kind of the host's error.
 * It never reads what an agent wrote.
 */

/** What the classifier is given about one stopped or failed step. */
export interface StopFacts {
  /** The step that stopped. */
  readonly step: string;
  /** The result the flow took: `failed`, `interrupted` (a recovered run) and so on. */
  readonly result: string;
  /** The reason dev recorded for a failed result, when it recorded one. */
  readonly reason?: string | undefined;
  /** The step that was not loaded, when the reason is `step_not_loaded`. */
  readonly use?: string | undefined;
  /** A person cancelled the task: nothing is retried. */
  readonly cancelled?: boolean | undefined;
}

/** Where a failure came from: outside the task's work, or in it. */
export type StopKind = "environment" | "task";

export interface StopVerdict {
  readonly kind: StopKind;
  /** What was wrong, as a waiting line says it; set for an environment failure. */
  readonly cause?: string | undefined;
  /** What the retry waits for; absent when it may run at once. */
  readonly waitFor?: "step" | "settings" | undefined;
  readonly use?: string | undefined;
}

/** The reasons dev records when a step stops for a cause outside the task. */
export const STOP_REASONS = {
  stepNotLoaded: "step_not_loaded",
  settingsUnreadable: "settings_unreadable",
  stopped: "stopped",
  /** A harness or model connection that dropped: the socket closed, a reset, a failed fetch. */
  connection: "connection_error",
  /** A repair run that only puts a task whose run ended in front of a person. */
  runEnded: "run_ended",
} as const;

const CONNECTION_ERROR = new RegExp(
  [
    "socket connection was closed unexpectedly",
    "socket hang up",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EPIPE",
    "fetch failed",
    "network error",
    "connection (?:error|reset|closed|lost)",
    "unable to connect",
  ].join("|"),
  "i",
);

/**
 * True when text a harness or the host printed for a failed step says the
 * connection to the model dropped. This reads the error the host gave, never
 * what an agent wrote in its answer.
 */
export function isConnectionError(...texts: readonly (string | undefined)[]): boolean {
  return texts.some((text) => text !== undefined && CONNECTION_ERROR.test(text));
}

const TASK: StopVerdict = { kind: "task" };

export function classifyStop(facts: StopFacts): StopVerdict {
  if (facts.cancelled === true) return TASK;
  if (facts.reason === STOP_REASONS.runEnded) return TASK;
  // A run that was recovered or stopped never reached a verdict on the work.
  if (facts.result === "interrupted") {
    return { kind: "environment", cause: `run stopped during ${facts.step}` };
  }
  switch (facts.reason) {
    case STOP_REASONS.stepNotLoaded:
      if (facts.use === undefined || facts.use.length === 0) return TASK;
      return {
        kind: "environment",
        cause: `${facts.use} is not loaded`,
        waitFor: "step",
        use: facts.use,
      };
    case STOP_REASONS.settingsUnreadable:
      return {
        kind: "environment",
        cause: "settings could not be read",
        waitFor: "settings",
      };
    case STOP_REASONS.connection:
      return { kind: "environment", cause: `model connection dropped during ${facts.step}` };
    case STOP_REASONS.stopped:
      return { kind: "environment", cause: `run stopped during ${facts.step}` };
    default:
      return TASK;
  }
}
