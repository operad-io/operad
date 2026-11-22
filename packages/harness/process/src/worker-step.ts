/**
 * The second half of the `agent` step of the process harnesses that speak a
 * line protocol over stdin and stdout: the call asker, the run, the log and the
 * result. claude and pi share this shape; only the program and the way one line
 * names a tool call differ.
 */

import { AskTimeoutError, type PluginStepResult } from "@operad-io/engine";
import type { AgentStepAccess, AgentStepValues } from "./agent-step.ts";
import { askFormRequest, askToolEvent, createCallAsker, formAnswer, type AskForm } from "./ask-call.ts";
import { answerGrant } from "./grants.ts";
import { inboxOf } from "./inbox.ts";
import { JsonlLog } from "./jsonl-log.ts";
import { deliverLine } from "./lines.ts";
import { runAgent, skippedLineRecord,type KeptRunOptions, type ToolEvent } from "./process.ts";
import { resultFor, resultValue, type AgentWorkerResult } from "./step.ts";
import { withTimings } from "./timings.ts";
import type { Clock } from "@operad-io/engine/platform";

/** What one process harness adds to the shared run of its worker. */
export interface WorkerStepSpec {
  readonly values: AgentStepValues<string>;
  readonly access: AgentStepAccess;
  readonly command: string;
  readonly args: readonly string[];
  /** The JSON object written to the worker's stdin. */
  readonly stdin: Record<string, unknown>;
  readonly keep: KeptRunOptions | undefined;
  readonly clock: Clock;
  readonly now: () => number;
  /** The classifier of this harness's tool call lines. */
  readonly toolEvent: (line: string) => ToolEvent | undefined;
  /** True when the worker puts an agent's own question to a person. */
  readonly forms?: boolean | undefined;
  /** True when a done result names the model that did the work. */
  readonly modelFromResult?: boolean | undefined;
}

/**
 * Runs one worker, answers its permission lines and reads the last `result`
 * line. A question that ran out of grace ends the worker, and the kernel turns
 * that into the result `waiting`.
 */
export async function runWorkerStep(spec: WorkerStepSpec): Promise<PluginStepResult> {
  const { values, access } = spec;
  const { ctx, harness, timings } = values;
  const inbox = inboxOf(values.params);
  const jsonl = new JsonlLog(ctx.logger, spec.clock, spec.now);
  let result: AgentWorkerResult | undefined;
  // Ends the program when a question about a call runs out of grace.
  const stopper = new AbortController();
  const asker = createCallAsker({
    ask: (request) => ctx.ask(request),
    ...(spec.forms === true
      ? {
          // The agent's own questions are one form the person fills in.
          async askForm(form: AskForm) {
            try {
              return formAnswer(await ctx.ask(askFormRequest(form)));
            } catch (error) {
              if (error instanceof AskTimeoutError) return { decision: "stop" as const };
              throw error;
            }
          },
        }
      : {}),
    onStop: () => stopper.abort(),
    secrets: access.secrets,
    ...(access.allowAlways ? { alwaysAllow: { home: ctx.home, cwd: values.cwd } } : {}),
    ...(ctx.flow === undefined ? {} : { targetGrants: { home: ctx.home, flow: ctx.flow } }),
    onLog: (message) => {
      void ctx.logger.write(message);
    },
  });

  const outcome = await runAgent({
    command: spec.command,
    args: spec.args,
    cwd: values.cwd,
    stdin: JSON.stringify(spec.stdin),
    interactive: access.interactive,
    inbox,
    ...(spec.keep === undefined ? {} : { keep: spec.keep }),
    wallMs: values.wallTimeSecs * 1000,
    stallMs: values.stallSecs * 1000,
    signal: AbortSignal.any([ctx.signal, stopper.signal]),
    clock: spec.clock,
    toolEvent: (line) => spec.toolEvent(line) ?? askToolEvent(line),
    onSkipped: (chars) => {
      void jsonl.pushStamped(jsonl.stamp(skippedLineRecord(chars)));
    },
    async onLine(line, reply) {
      const received = jsonl.stamp(line);
      timings.record(received.value, received.at);
      await answerGrant(received.text, (waitId) => ctx.useGrant(waitId), reply);
      await asker.handle(received.text, reply);
      const writing = jsonl.pushStamped(received);
      deliverLine(ctx.receiver, received.text, access.secrets);
      const parsed = resultValue<AgentWorkerResult>(received.value);
      if (parsed !== undefined) result = parsed;
      return writing;
    },
  });
  await jsonl.end();

  // The grace passed with a question open: the program was ended on purpose.
  const unanswered = asker.stopped();
  if (unanswered !== undefined && !ctx.signal.aborted) throw unanswered.error;

  const timing = timings.finish();
  const stepResult = resultFor(
    // The step's own model, else the one the worker reports having used.
    { harness, model: spec.modelFromResult === true ? (values.model ?? result?.model ?? null) : (values.model ?? null) },
    outcome,
    result,
    ctx.logger.path,
    timing.totalMs,
    { wallTimeSecs: values.wallTimeSecs, stallSecs: values.stallSecs },
    spec.command,
  );
  return withTimings(stepResult, timing);
}
