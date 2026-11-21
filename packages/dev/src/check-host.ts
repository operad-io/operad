/**
 * The check host and its slots: the home's `dev.checkHost` and `dev.checkSlots`
 * become the environment of every gate, integration and rerun command. A
 * repository whose commands use `remote-check.sh` is told when neither
 * the settings nor serve's own environment names a host.
 */

import type { CheckCommand, DevSettings } from "./settings.ts";

/** The variable `remote-check.sh` reads to find its host. */
export const CHECK_HOST_VARIABLE = "OPERAD_CHECK_HOST";

/** The variable `remote-check.sh` reads for how many checks run at once. */
export const CHECK_SLOTS_VARIABLE = "OPERAD_CHECK_SLOTS";

/** The script a repository's check commands may use to run on another machine. */
export const REMOTE_CHECK_SCRIPT = "remote-check.sh";

/** An environment to read the explicit variables from; a test passes its own. */
type Environment = Readonly<Record<string, string | undefined>>;

/** The host a setting names, or undefined when the setting is absent. */
function hostSetting(settings: Readonly<Record<string, unknown>>): string | undefined {
  const value = settings.checkHost;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("dev settings: checkHost must be a non-empty string");
  }
  return value;
}

/** How many checks the setting allows on the host, or undefined. */
function slotsSetting(settings: Readonly<Record<string, unknown>>): number | undefined {
  const value = settings.checkSlots;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("dev settings: checkSlots must be a whole number of 1 or more");
  }
  return value;
}

/**
 * The host the commands should use: the explicit variable in serve's own
 * environment first, then the home's setting. Empty means the check runs here,
 * which is also what an absent host means.
 */
export function checkHostOf(
  settings: Readonly<Record<string, unknown>>,
  env: Environment = process.env,
): string | undefined {
  const explicit = env[CHECK_HOST_VARIABLE];
  if (explicit !== undefined) return explicit.length === 0 ? undefined : explicit;
  return hostSetting(settings);
}

/**
 * The environment a gate, integration or rerun command gets: the host and
 * slots from the home's settings. A variable already in serve's own
 * environment wins, including an empty one, and is left to be inherited.
 */
export function checkEnvironment(
  settings: Readonly<Record<string, unknown>>,
  env: Environment = process.env,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (env[CHECK_HOST_VARIABLE] === undefined) {
    const host = hostSetting(settings);
    if (host !== undefined) out[CHECK_HOST_VARIABLE] = host;
  }
  if (env[CHECK_SLOTS_VARIABLE] === undefined) {
    const slots = slotsSetting(settings);
    if (slots !== undefined) out[CHECK_SLOTS_VARIABLE] = String(slots);
  }
  return out;
}

/** Whether one check command, or the rerun of its failed tests, uses the script. */
function commandUsesRemoteCheck(command: CheckCommand): boolean {
  const run = typeof command === "string" ? command : command.run;
  if (run.includes(REMOTE_CHECK_SCRIPT)) return true;
  return typeof command !== "string" && (command.failed?.rerun.includes(REMOTE_CHECK_SCRIPT) ?? false);
}

/** Whether any check command a repository runs uses `remote-check.sh`. */
export function usesRemoteCheck(settings: DevSettings): boolean {
  if (settings.gate.commands.some(commandUsesRemoteCheck)) return true;
  if (settings.integration.keyCommands.some(commandUsesRemoteCheck)) return true;
  for (const flow of Object.values(settings.flows)) {
    for (const stage of flow.stages) {
      if (stage.stage !== "test" && stage.stage !== "check") continue;
      if (stage.commands?.some(commandUsesRemoteCheck) === true) return true;
    }
  }
  return false;
}

/**
 * The one line dev says, and marks where a person looks, when a repository's
 * check commands use `remote-check.sh` but no host is set. Undefined
 * when a host is set or the commands do not use the script.
 */
export function checkHostWarning(
  repository: string,
  repositorySettings: DevSettings,
  homeSettings: Readonly<Record<string, unknown>>,
  env: Environment = process.env,
): string | undefined {
  if (checkHostOf(homeSettings, env) !== undefined) return undefined;
  if (!usesRemoteCheck(repositorySettings)) return undefined;
  return `check commands use ${REMOTE_CHECK_SCRIPT} but no check host is set, so they run here (repository "${repository}"; set dev.checkHost or ${CHECK_HOST_VARIABLE})`;
}
