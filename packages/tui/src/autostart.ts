/**
 * `operad tui` starts `operad serve` itself when none answers: it probes the
 * address, refuses to start a second serve for a home that already has one,
 * starts one detached when the home is free, and waits for it to answer. It
 * never opens the store and never loads a plugin.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lastLines } from "@operad-io/engine/platform";
import {
  lockHeld,
  readConfig,
  serveLockPath,
} from "@operad-io/engine";
import { defaultFetch, TuiError, type FetchLike } from "./client.ts";
import { urlFromConfig } from "./discover.ts";

/** How long the first probe waits for an answer. */
export const PROBE_TIMEOUT_MS = 1_500;

/** How long a started serve has to answer. */
export const START_TIMEOUT_MS = 15_000;

/** How often a started serve is probed. */
export const START_POLL_MS = 100;

/** The server could not be reached or started; the message says why. */
export class TuiStartError extends TuiError {
  constructor(message: string) {
    super(message, { kind: "start" });
    this.name = "TuiStartError";
  }
}

/** What a probe of `GET /v1/types` found. */
export type Probe = "operad" | "silent" | "other";

/**
 * Asks the address for `/v1/types` without a token. An operad server answers
 * either the list (`200`) or its own error body (`401`); anything else that
 * answers is not operad, and nothing answering is silent.
 */
export async function probeServer(
  url: string,
  fetchImpl: FetchLike = defaultFetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/v1/types`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "silent";
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "other";
  }
  if (typeof body !== "object" || body === null) return "other";
  if (response.status === 200 && "types" in body && Array.isArray(body.types)) {
    return "operad";
  }
  if (
    response.status === 401 &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return "operad";
  }
  return "other";
}

/** A serve that was started: it resolves when the process has exited. */
export interface StartedServe {
  readonly exited: Promise<number | null>;
  /** The process id, when the system gave one. */
  readonly pid?: number | undefined;
}

/** Starts `operad serve` for a home, appending its output to `log`. */
export type ServeSpawner = (log: string) => StartedServe;

/**
 * The real spawner: the runtime and entry of the current process, detached
 * from it so the serve keeps running after the TUI quits.
 */
export function spawnServe(home: string, entry: string): ServeSpawner {
  return (log) => {
    const fd = openSync(log, "a");
    try {
      const child = spawn(process.execPath, [entry, "serve"], {
        cwd: home,
        env: { ...process.env, OPERAD_HOME: home },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      const exited = new Promise<number | null>((resolve) => {
        child.once("error", () => resolve(null));
        child.once("exit", (code) => resolve(code));
      });
      child.unref();
      return { exited, pid: child.pid };
    } finally {
      closeSync(fd);
    }
  };
}

/** The options of `ensureServer`. */
export interface EnsureServerOptions {
  readonly home: string;
  readonly fetch?: FetchLike | undefined;
  /** Required to start anything; without it nothing is started. */
  readonly spawn?: ServeSpawner | undefined;
  /** Prints the one line before the full screen opens. */
  readonly write?: ((line: string) => void) | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly startTimeoutMs?: number | undefined;
  readonly pollMs?: number | undefined;
  /** Tests inject a wait instead of a timer. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** The clock the start deadline is read from; probe time counts. */
  readonly now?: (() => number) | undefined;
  /** Tests inject the home lock check. */
  readonly lockHeld?: ((path: string) => boolean) | undefined;
}

/** True when a serve's log says it could not listen because the port is taken. */
export function portInUse(text: string): boolean {
  return /Failed to start server|EADDRINUSE|address already in use|port \d+ in use/i.test(text);
}

function readLog(log: string): string {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

function tailOf(log: string): string {
  try {
    const lines = lastLines(readFileSync(log, "utf8"), 10);
    return lines.length === 0 ? "(the log is empty)" : lines.join("\n");
  } catch {
    return "(no log was written)";
  }
}

/**
 * Makes sure a serve answers at the address `config.json` names, starting one
 * when none runs and none holds the home. Returns the URL.
 */
export async function ensureServer(options: EnsureServerOptions): Promise<string> {
  const { home } = options;
  const config = await readConfig(home);
  const url = urlFromConfig(config.http.listen, config.http.port);
  const fetchImpl = options.fetch ?? defaultFetch;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const first = await probeServer(url, fetchImpl, options.probeTimeoutMs);
  if (first === "operad") return url;
  if (first === "other") {
    throw new TuiStartError(
      `something answers at ${url} (port ${config.http.port}) but it is not operad; change http.port in config.json or pass --url`,
    );
  }
  if (!config.http.enabled) {
    throw new TuiStartError(
      `http.enabled is false in config.json, so no serve listens at ${url}; set it to true or pass --url`,
    );
  }
  if ((options.lockHeld ?? lockHeld)(serveLockPath(home))) {
    throw new TuiStartError(
      `an operad serve already runs for this home but does not answer at ${url}; check http.enabled, http.listen and http.port in config.json`,
    );
  }
  if (options.spawn === undefined) {
    throw new TuiStartError(`no operad serve answers at ${url}`);
  }

  const log = join(home, "serve.log");
  // Only what the started serve writes counts, not what older ones left.
  const logBefore = readLog(log).length;
  options.write?.(`starting operad serve (log: ${log})`);
  const started = options.spawn(log);
  let exitCode: number | null | undefined;
  void started.exited.then((code) => {
    exitCode = code;
  });

  const now = options.now ?? Date.now;
  const lockCheck = options.lockHeld ?? lockHeld;
  const timeout = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const step = options.pollMs ?? START_POLL_MS;
  const deadline = now() + timeout;
  // Another `operad tui` may have started the serve first. Our child then
  // lost the lock and exited, and the winner is the one to wait for.
  let adopted = false;
  for (;;) {
    if (exitCode !== undefined && !adopted) {
      if (!lockCheck(serveLockPath(home))) {
        if (portInUse(readLog(log).slice(logBefore))) {
          throw new TuiStartError(
            `operad serve could not start: port ${config.http.port} is in use and nothing answers on ${url}; an operad serve of this home that still runs does not answer on ${url}; log ${log}:\n${tailOf(log)}`,
          );
        }
        throw new TuiStartError(
          `operad serve exited at once${exitCode === null ? "" : ` (code ${exitCode})`}; log ${log}:\n${tailOf(log)}`,
        );
      }
      adopted = true;
    }
    if ((await probeServer(url, fetchImpl, options.probeTimeoutMs)) === "operad") {
      return url;
    }
    if (now() >= deadline) break;
    await wait(step);
  }
  if (adopted) {
    // The serve that holds the home lock is not ours and did not answer.
    throw new TuiStartError(
      `an operad serve already runs for this home but does not answer at ${url} within ${Math.round(timeout / 1000)} seconds; check http.enabled, http.listen and http.port in config.json; log ${log}:\n${tailOf(log)}`,
    );
  }
  throw new TuiStartError(
    `operad serve did not answer at ${url} within ${Math.round(timeout / 1000)} seconds; log ${log}:\n${tailOf(log)}`,
  );
}
