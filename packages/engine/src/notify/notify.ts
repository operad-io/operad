/**
 * The notification hook. When an object starts waiting for a person, `serve`
 * runs the configured command once for that wait.
 *
 * One notification is identified by `notify:<runId>:<waitId>`: the run, and the
 * wait's own id, which names the step and its visit (`ask:2` is the second time
 * the run reached `ask`). A run that waits at the same step again is a new wait
 * and notifies again; a restart of `serve` while the same wait is open is not.
 *
 * The notification is recorded as one global fact of kind `notified`, written
 * with that key as its unique key, after the command has ended. A crash between
 * the command and the fact therefore causes at most one extra notification when
 * `serve` starts again; a crash before the command loses nothing, because
 * nothing was recorded and the next pass sends it. A command that fails or
 * times out is recorded too and is not retried.
 */

import type { NotifyConfig } from "../config/config.ts";
import { objectLink } from "../http/link.ts";
import type { LogBackend } from "../log/types.ts";
import { messageOf } from "../plugin/errors.ts";
import { runLine } from "../platform/process-group.ts";
import { parseObjectKey, readState } from "../runner/service.ts";

/** The fact kind a recorded notification has. */
export const NOTIFIED_FACT = "notified";

/** How long the command may run. */
export const NOTIFY_TIMEOUT_MS = 30_000;

/** How many lines of the command's output a failure report keeps. */
const TAIL_LINES = 5;

/** What one run of the command did. */
export interface HookOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error: string | undefined;
  readonly tail: readonly string[];
}

/** Runs the command; a test replaces it to count and to crash. */
export type HookRunner = (
  line: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<HookOutcome>;

export interface NotifierOptions {
  readonly home: string;
  readonly config: NotifyConfig;
  readonly log: LogBackend;
  /** The title of an object, for `OPERAD_TITLE`; failing means the id is used. */
  readonly titleOf?: ((type: string, id: string) => Promise<string>) | undefined;
  /**
   * True when the object's plugin answers its wait itself; no notice is sent
   * for it, and none is recorded, so a wait that stays unanswered is noticed
   * by a later scan. A failing hook means false.
   */
  readonly answeredAutomatically?:
    | ((object: { readonly type: string; readonly id: string }) => Promise<boolean>)
    | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  readonly run?: HookRunner | undefined;
  /** Replaces the write of the `notified` fact; a test makes it fail. */
  readonly record?:
    | ((key: string, payload: Record<string, string | number | boolean | null>) => Promise<void>)
    | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The key that identifies one notification. */
export function notificationKey(runId: string, waitId: string): string {
  return `notify:${runId}:${waitId}`;
}

/** The default runner: `sh -c` in the home, in a process group of its own. */
export function shellHookRunner(home: string, timeoutMs: number): HookRunner {
  return async (line, env, signal) => {
    const outcome = await runLine({
      line,
      cwd: home,
      env,
      timeoutMs,
      signal,
    });
    return {
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      error: outcome.spawnError,
      tail: outcome.tail,
    };
  };
}

function describeFailure(outcome: HookOutcome): string {
  const how = outcome.timedOut
    ? "timed out"
    : outcome.error !== undefined
      ? `could not start: ${outcome.error}`
      : `exited ${outcome.exitCode ?? "without a code"}`;
  const tail = outcome.tail.slice(-TAIL_LINES).join("\n");
  return tail.length === 0 ? how : `${how}\n${tail}`;
}

/** Finds the waits that need a notification and runs the command for each. */
export class Notifier {
  private readonly options: NotifierOptions;
  private readonly run: HookRunner;
  private readonly controller = new AbortController();
  private recorded: Set<string> | undefined;
  private running: Promise<void> | undefined;

  constructor(options: NotifierOptions) {
    this.options = options;
    this.run =
      options.run ??
      shellHookRunner(options.home, options.timeoutMs ?? NOTIFY_TIMEOUT_MS);
  }

  private get enabled(): boolean {
    return (
      this.options.config.command !== null &&
      this.options.config.on.includes("waiting")
    );
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  private async loadRecorded(): Promise<Set<string>> {
    if (this.recorded !== undefined) return this.recorded;
    const keys = new Set<string>();
    for await (const fact of this.options.log.readGlobal()) {
      if (fact.kind !== NOTIFIED_FACT) continue;
      const payload = fact.payload;
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof payload.key === "string"
      ) {
        keys.add(payload.key);
      }
    }
    this.recorded = keys;
    return keys;
  }

  /**
   * One scan: every wait without a recorded notification gets its command.
   * A scan that is still running when the next is asked for is not repeated.
   */
  pass(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running !== undefined) return this.running;
    const current = this.scan().finally(() => {
      this.running = undefined;
    });
    this.running = current;
    return current;
  }

  /** Stops commands that are running (they are not recorded) and waits for the scan. */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.running?.catch(() => undefined);
  }

  private async scan(): Promise<void> {
    const recorded = await this.loadRecorded();
    const runs = await this.options.log.runs({ active: true });
    for (const run of runs) {
      if (this.controller.signal.aborted) return;
      const object = parseObjectKey(run.object);
      if (object === undefined) continue;
      let state;
      try {
        state = await readState(this.options.log, run.runId);
      } catch (error) {
        this.log(`notify: run "${run.runId}": ${messageOf(error)}`);
        continue;
      }
      if (state.status !== "waiting_person" || state.wait === null) continue;
      const key = notificationKey(run.runId, state.wait.id);
      if (recorded.has(key)) continue;
      try {
        if ((await this.options.answeredAutomatically?.(object)) === true) continue;
      } catch {
        // A hook that fails answers nothing: the person is told.
      }
      await this.notify(key, run.runId, state.wait.id, object, state.wait.prompt);
    }
  }

  private async notify(
    key: string,
    runId: string,
    waitId: string,
    object: { readonly type: string; readonly id: string },
    prompt: string,
  ): Promise<void> {
    const command = this.options.config.command;
    if (command === null) return;
    const id = `${object.type}:${object.id}`;
    let title = object.id;
    try {
      title = (await this.options.titleOf?.(object.type, object.id)) ?? title;
    } catch {
      // The id is a title good enough for a notice.
    }
    const outcome = await this.run(
      command,
      {
        OPERAD_ID: id,
        OPERAD_TITLE: title,
        OPERAD_REASON: prompt,
        OPERAD_LINK: objectLink(object.type, object.id),
      },
      this.controller.signal,
    );
    // A stop is not a failure and not a notification: the next `serve` sends it.
    if (outcome.cancelled) return;
    const ok =
      outcome.exitCode === 0 && !outcome.timedOut && outcome.error === undefined;
    if (!ok) {
      this.log(`notify: the command for ${id} ${describeFailure(outcome)}`);
    }
    const payload = {
      key,
      runId,
      waitId,
      object: id,
      ok,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
    };
    try {
      if (this.options.record !== undefined) {
        await this.options.record(key, payload);
      } else {
        await this.options.log.appendGlobal(
          { kind: NOTIFIED_FACT, payload, cause: runId },
          key,
        );
      }
      this.recorded?.add(key);
    } catch (error) {
      // Not recorded: the next `serve` sends this one again, once.
      this.log(`notify: could not record the notice for ${id}: ${messageOf(error)}`);
    }
  }
}
