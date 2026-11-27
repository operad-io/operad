/**
 * What `operad bot login` prints after it starts a login: `serve` runs the
 * login and asks its first question a moment later, so the command waits for
 * that question and prints the command it carries (ADR 0008 D9).
 */

import { loginFlow } from "@operad-io/bot";
import {
  listPending,
  lockHeld,
  openConfigLog,
  serveLockPath,
  type AskTimer,
  type LogBackend,
  type OperadConfig,
  type PluginRegistry,
} from "@operad-io/engine";

/** The longest the command line waits for the login's first question, in seconds. */
export const LOGIN_QUESTION_WAIT_SECS = 30;

export interface LoginCommandWait {
  readonly home: string;
  readonly config: OperadConfig;
  readonly registry: PluginRegistry;
  /** The bot, as `bot:<name>`. */
  readonly object: string;
  readonly write: (text: string) => void;
  readonly timer: AskTimer;
}

/**
 * Prints the open login question of a bot and the command it carries, each on
 * its own line. It stops without a word when the question carries no command,
 * the login has ended, no `serve` runs it, or the wait is over.
 */
export async function showLoginCommand(wait: LoginCommandWait): Promise<void> {
  // A command that answers once opens its log without change events; this one
  // waits for what `serve` writes, so it opens a log that follows it.
  const log = openConfigLog(wait.config);
  try {
    await waitForQuestion(wait, log);
  } finally {
    await log.close();
  }
}

function waitForQuestion(wait: LoginCommandWait, log: LogBackend): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let looking = false;
    let again = false;
    let cancelTimer: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      cancelTimer?.();
      unsubscribe?.();
      if (error === undefined) resolve();
      else reject(error);
    };
    /** True when there is nothing more to wait for. */
    const settled = async (): Promise<boolean> => {
      const runs = (await log.runs({ object: wait.object, active: true })).filter(
        (run) => run.flow === loginFlow.name,
      );
      if (runs.length === 0) return true;
      const question = (await listPending(log, wait.registry)).find(
        (item) => item.waitId !== undefined && runs.some((run) => run.runId === item.runId),
      );
      // The time may have run out while this looked; nothing is printed then.
      if (finished) return true;
      if (question === undefined) return !lockHeld(serveLockPath(wait.home));
      if (question.command !== undefined) {
        wait.write(`  waiting: ${question.prompt}\n    ${question.command}\n`);
      }
      return true;
    };
    const look = async (): Promise<void> => {
      if (looking) {
        again = true;
        return;
      }
      looking = true;
      try {
        do {
          again = false;
          if (finished || (await settled())) return finish();
        } while (again);
      } catch (error) {
        finish(error);
      } finally {
        looking = false;
      }
    };
    // Subscribed before the first look, so a question opened in between is seen.
    unsubscribe = log.subscribe?.(() => void look());
    cancelTimer = wait.timer(LOGIN_QUESTION_WAIT_SECS * 1000, () => finish());
    void look();
  });
}
