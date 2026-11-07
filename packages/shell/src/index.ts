/**
 * The base plugin installed with operad: it runs a shell line, a list of
 * checks, and a probe the kernel's `wait` step can poll. The kernel never runs
 * a command itself.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  definePlugin,
  type PluginLogger,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  runLine,
  type Clock,
  type LineOutcome,
} from "@operad-io/engine/platform";

function paramsObject(params: unknown, at: string): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(`${at}: params: must be an object`);
  }
  return params as Record<string, unknown>;
}

function lineParam(params: Record<string, unknown>, at: string): string {
  const line = params.line;
  if (typeof line !== "string" || line.trim().length === 0) {
    throw new Error(`${at}: params.line: must be a non-empty string`);
  }
  return line;
}

function cwdParam(ctx: StepContext, params: Record<string, unknown>, at: string): string {
  const cwd = params.cwd;
  if (cwd === undefined) return ctx.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error(`${at}: params.cwd: must be a non-empty string`);
  }
  return cwd;
}

function timeoutParam(
  params: Record<string, unknown>,
  at: string,
): { readonly ms: number | undefined; readonly secs: number | undefined } {
  const secs = params.timeoutSecs;
  if (secs === undefined) return { ms: undefined, secs: undefined };
  if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0) {
    throw new Error(`${at}: params.timeoutSecs: must be zero or more seconds`);
  }
  return { ms: secs * 1000, secs };
}

function envParam(
  params: Record<string, unknown>,
  at: string,
): Readonly<Record<string, string>> | undefined {
  const env = params.env;
  if (env === undefined) return undefined;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`${at}: params.env: must be an object of strings`);
  }
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new Error(`${at}: params.env.${key}: must be a string`);
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** The reason a directory cannot be a working directory, if it cannot. */
async function directoryError(cwd: string): Promise<string | undefined> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? undefined : `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
}

async function writeNote(logger: PluginLogger, note: string): Promise<string> {
  return logger.write(note);
}

function failureData(
  outcome: LineOutcome,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    log: outcome.log,
    tail: outcome.tail,
    ...extra,
  };
}

function commandResult(
  outcome: LineOutcome,
  timeoutSecs: number | undefined,
): PluginStepResult {
  if (outcome.spawnError !== undefined) {
    return {
      result: "fail",
      data: failureData(outcome, {
        reason: "spawn",
        message: outcome.spawnError,
      }),
    };
  }
  if (outcome.cancelled) {
    return {
      result: "interrupted",
      data: failureData(outcome, { reason: "cancelled" }),
    };
  }
  if (outcome.timedOut) {
    const limit = timeoutSecs === undefined ? "" : ` after ${timeoutSecs}s`;
    return {
      result: "fail",
      data: failureData(outcome, {
        reason: "timeout",
        message: `the command was stopped${limit}`,
      }),
    };
  }
  if (outcome.exitCode === 0) {
    return { result: "pass", data: failureData(outcome, {}) };
  }
  const killed =
    outcome.exitCode === null && outcome.signal !== null
      ? `the command was killed by ${outcome.signal}`
      : `the command exited ${String(outcome.exitCode)}`;
  return {
    result: "fail",
    data: failureData(outcome, {
      reason: outcome.exitCode === null ? "signal" : "exit",
      message: killed,
    }),
  };
}

function probeId(runId: string, cwd: string, line: string): string {
  return createHash("sha256")
    .update(JSON.stringify([runId, cwd, line]))
    .digest("hex");
}

/** Options for the shell plugin. A test injects a clock to control timeouts. */
export interface ShellPluginOptions {
  readonly clock?: Clock | undefined;
}

export function createShellPlugin(options: ShellPluginOptions = {}) {
  const clock = options.clock;
  return definePlugin({
    name: "shell",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "command",
        results: ["pass", "fail", "interrupted"],
        async run(ctx, params) {
          const at = "shell/command";
          const input = paramsObject(params, at);
          const line = lineParam(input, at);
          const cwd = cwdParam(ctx, input, at);
          const env = envParam(input, at);
          const timeout = timeoutParam(input, at);

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) {
            const log = await writeNote(ctx.logger, cwdProblem);
            return {
              result: "fail",
              data: {
                reason: "cwd",
                message: cwdProblem,
                exitCode: null,
                log,
                tail: [cwdProblem],
              },
            };
          }

          const outcome = await runLine({
            line,
            cwd,
            env,
            timeoutMs: timeout.ms,
            signal: ctx.signal,
            logger: ctx.logger,
            clock,
          });
          return commandResult(outcome, timeout.secs);
        },
      },
      {
        name: "check",
        results: ["pass", "fail", "interrupted"],
        async run(ctx, params) {
          const at = "shell/check";
          const input = paramsObject(params, at);
          const lines = input.lines;
          if (
            !Array.isArray(lines) ||
            !lines.every(
              (line): line is string =>
                typeof line === "string" && line.trim().length > 0,
            )
          ) {
            throw new Error(
              `${at}: params.lines: must be an array of non-empty strings`,
            );
          }
          const cwd = cwdParam(ctx, input, at);
          const timeout = timeoutParam(input, at);

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) {
            const log = await writeNote(ctx.logger, cwdProblem);
            return {
              result: "fail",
              data: {
                reason: "cwd",
                message: cwdProblem,
                exitCode: null,
                log,
                tail: [cwdProblem],
              },
            };
          }

          if (lines.length === 0) {
            const log = await ctx.logger.write("");
            return { result: "pass", data: { lines: 0, log, tail: [] } };
          }

          for (const [index, line] of lines.entries()) {
            if (ctx.signal.aborted) {
              // No line has written output yet: create the log the fact names,
              // so the path is a file a reader can open.
              const log = await writeNote(ctx.logger, "");
              return {
                result: "interrupted",
                data: {
                  reason: "cancelled",
                  line,
                  lineNumber: index + 1,
                  log,
                  tail: [],
                },
              };
            }

            const outcome = await runLine({
              line,
              cwd,
              timeoutMs: timeout.ms,
              signal: ctx.signal,
              logger: ctx.logger,
              clock,
            });

            if (outcome.cancelled) {
              return {
                result: "interrupted",
                data: failureData(outcome, {
                  reason: "cancelled",
                  line,
                  lineNumber: index + 1,
                }),
              };
            }

            if (
              outcome.spawnError !== undefined ||
              outcome.timedOut ||
              outcome.exitCode !== 0
            ) {
              const reason =
                outcome.spawnError !== undefined
                  ? "spawn"
                  : outcome.timedOut
                    ? "timeout"
                    : outcome.exitCode === null
                      ? "signal"
                      : "exit";
              const message =
                outcome.spawnError ??
                (outcome.timedOut
                  ? `check line ${index + 1} was stopped after ${String(timeout.secs)}s`
                  : outcome.exitCode === null
                    ? `check line ${index + 1} was killed by ${String(outcome.signal)}`
                    : `check line ${index + 1} exited ${String(outcome.exitCode)}`);
              return {
                result: "fail",
                data: failureData(outcome, {
                  reason,
                  message,
                  line,
                  lineNumber: index + 1,
                }),
              };
            }
          }

          return {
            result: "pass",
            data: {
              lines: lines.length,
              log: ctx.logger.path,
              tail: [],
            },
          };
        },
      },
      {
        name: "probe",
        results: ["ready", "waiting", "interrupted"],
        async run(ctx, params) {
          const at = "shell/probe";
          const input = paramsObject(params, at);
          const line = lineParam(input, at);
          const cwd = cwdParam(ctx, input, at);
          const timeout = timeoutParam(input, at);

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) {
            return {
              result: "interrupted",
              data: { reason: "cwd", message: cwdProblem },
            };
          }

          const outcome = await runLine({
            line,
            cwd,
            timeoutMs: timeout.ms,
            signal: ctx.signal,
            clock,
          });
          if (outcome.cancelled) {
            return { result: "interrupted", data: { reason: "cancelled" } };
          }
          if (outcome.spawnError !== undefined) {
            return {
              result: "interrupted",
              data: { reason: "spawn", message: outcome.spawnError },
            };
          }
          if (outcome.timedOut) {
            return {
              result: "interrupted",
              data: {
                reason: "timeout",
                message: `the probe was stopped after ${String(timeout.secs)}s`,
              },
            };
          }

          const exitCode = outcome.exitCode;
          const id = probeId(ctx.runId, cwd, line);
          const previous = await ctx.store.get("probe", id);
          const data = { line, cwd, exitCode };
          if (previous === undefined) {
            await ctx.store.put("probe", id, data, "probe");
            return { result: "waiting", data };
          }

          const before = previous.data.exitCode;
          const previousCode = typeof before === "number" ? before : null;
          if (previousCode !== exitCode) {
            await ctx.store.put("probe", id, data, "probe");
            return { result: "ready", data };
          }
          return { result: "waiting", data };
        },
      },
    ],
    check() {
      return "ready";
    },
  });
}

export default createShellPlugin();
