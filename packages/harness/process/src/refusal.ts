/**
 * The early failed result of an agent step: the reason was found before the
 * program ran, so there is no exit code, session or usage. Every harness writes
 * it the same way, with its own reason and any field its plan adds.
 */

import type { PluginStepResult } from "@operad-io/engine";
import { withTimings, type StepTimings } from "./timings.ts";
import { standardUsage, type UsageSource } from "./usage.ts";

/** What one early refusal writes. */
export interface RefusalInput {
  /** Writes the message to the step's log and returns its path. */
  readonly log: (message: string) => Promise<string>;
  readonly timings: StepTimings;
  /** The harness and the model known before the run, for the usage line. */
  readonly who: UsageSource;
  readonly reason: string;
  readonly message: string;
  /** A field this harness's result carries, such as codex's image call count. */
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/** The `failed` result of a step that refused before it started its program. */
export async function refuseResult(input: RefusalInput): Promise<PluginStepResult> {
  const log = await input.log(input.message);
  const timing = input.timings.finish();
  return withTimings(
    {
      result: "failed",
      data: {
        reason: input.reason,
        message: input.message,
        exitCode: null,
        signal: null,
        sessionId: null,
        finalMessage: null,
        usage: standardUsage(input.who, undefined, null),
        log,
        durationMs: timing.totalMs,
        stderr: [input.message],
        ...input.extra,
      },
    },
    timing,
  );
}
