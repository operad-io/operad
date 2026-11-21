/**
 * The run time and stall limits every process harness has: the same defaults,
 * the same setting entries and the same four constants.
 */

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 3600;

/** How long an agent may go without a new output line. */
export const DEFAULT_STALL_SECS = 600;

/** One run of the step may take this long; it is above every allowed wall time. */
export const STEP_TIMEOUT_SECS = 8 * 3600;

/** The longest wall time a run may ask for: the step timeout minus a margin. */
export const MAX_WALL_TIME_SECS = STEP_TIMEOUT_SECS - 300;

/** The `wallTimeSecs` setting entry of a harness. */
export const WALL_TIME_SETTING = {
  type: "number" as const,
  title: "Run time limit",
  minimum: 1,
  maximum: MAX_WALL_TIME_SECS,
  default: DEFAULT_WALL_TIME_SECS,
  description: "The longest one agent run may take.",
};

/** The `stallSecs` setting entry of a harness. */
export const STALL_SETTING = {
  type: "number" as const,
  title: "Stall limit",
  minimum: 1,
  default: DEFAULT_STALL_SECS,
  description: "How long an agent may be silent while no tool call is open.",
};
