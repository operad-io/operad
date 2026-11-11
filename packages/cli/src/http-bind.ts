/**
 * Starting the listeners of a serve that took over from another one. The old
 * serve has released its addresses before the new one starts, but the system
 * may need a moment to hand them back, so a failed bind is tried again for a
 * bounded time before the new code gives up.
 */

import { ConfigError, HttpStopError } from "@operad-io/engine";
import { RELOAD_EXIT, takeSupervisedFlag } from "./code-reload.ts";

export interface BindRetryOptions {
  /** How long to keep trying, in milliseconds. */
  readonly retryMs: number;
  /** The wait between two tries. */
  readonly stepMs: number;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  /** Called with each failure that will be tried again. */
  readonly onRetry?: ((error: unknown) => void) | undefined;
}

/** The new code could not listen in time; the old code has to serve. */
export class BindFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BindFailed";
  }
}

/** Runs `start` until it succeeds or `retryMs` has passed; a bad configuration is not retried. */
export async function startWithRetry<T>(
  start: () => Promise<T>,
  options: BindRetryOptions,
): Promise<T> {
  const deadline = options.now() + options.retryMs;
  for (;;) {
    try {
      return await start();
    } catch (error) {
      if (error instanceof ConfigError || error instanceof HttpStopError) throw error;
      if (options.now() >= deadline) throw new BindFailed(error);
      options.onRetry?.(error);
    }
    await options.wait(options.stepMs);
  }
}

/** A serve whose listener would not release its address: this process cannot go on. */
export class HandOverStuck extends Error {
  readonly reload: boolean;
  constructor(cause: Error, reload: boolean) {
    super(cause.message);
    this.name = "HandOverStuck";
    this.reload = reload;
  }
}

/** Set in the environment of a serve that a stuck serve started in its place. */
export const REPLACES_ENV = "OPERAD_SERVE_REPLACES";

/** True when a stuck serve started this one; removes the flag from `env`. */
export function takeReplacesFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const replaces = env[REPLACES_ENV] === "1";
  delete env[REPLACES_ENV];
  return replaces;
}

export interface ServeStartFlags {
  readonly supervised: boolean;
  readonly replaces: boolean;
  /** A serve that is supervised or takes over from one asks again for its port. */
  readonly retryBind: boolean;
}

/** Takes the start flags from the environment, so no child sees them. */
export function serveStartFlags(env: NodeJS.ProcessEnv = process.env): ServeStartFlags {
  const supervised = takeSupervisedFlag(env);
  const replaces = takeReplacesFlag(env);
  return { supervised, replaces, retryBind: supervised || replaces };
}

/** The environment of a replacement a stuck serve starts in its place. */
export function replacementEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [REPLACES_ENV]: "1" };
}

export interface StuckActions {
  readonly supervised: boolean;
  /** Starts the same command line as a new process that retries its bind. */
  readonly startReplacement: () => void;
  /** Ends this process now, whatever handles it still holds. */
  readonly exit: (code: number) => never;
  readonly log: (message: string) => void;
}

/**
 * A listener that will not release its address is still a live handle, so the
 * process must end rather than return: it would go on serving only that
 * address. A reload still needs a serve afterwards: under a supervisor the
 * supervisor starts the next one; otherwise a replacement starts here, after
 * the home lock was released and before this process ends.
 */
export function leaveStuck(error: HandOverStuck, actions: StuckActions): never {
  actions.log(`${error.message}; this serve ends${error.reload ? " and a new one starts" : ""}\n`);
  if (error.reload && actions.supervised) return actions.exit(RELOAD_EXIT);
  if (error.reload) actions.startReplacement();
  return actions.exit(1);
}
