/**
 * The offered optional plugins (ADR 0010 D7), handed to the processes this one
 * starts: a tools server a harness opens is not started by the distribution,
 * and without the list it has no guide for a plugin `config.json` does not
 * name.
 */

import { isRecord } from "../util.ts";

/** The variable that carries the list, as a JSON object of name to module. */
export const OPTIONAL_PLUGINS_ENV = "OPERAD_OPTIONAL_PLUGINS";

/** Reads the list from its text; undefined when there is none or it is not one. */
export function parseOptionalPlugins(text: string | undefined): Readonly<Record<string, string>> | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const found: Record<string, string> = {};
  for (const [name, module] of Object.entries(value)) {
    if (typeof module === "string") found[name] = module;
  }
  return found;
}

/** Makes this process and the ones it starts hold the list. */
export function shareOptionalPlugins(
  optional: Readonly<Record<string, string>>,
  env: Record<string, string | undefined> = process.env,
): void {
  env[OPTIONAL_PLUGINS_ENV] = JSON.stringify(optional);
}

/** The list this process was handed; undefined when none was. */
export function sharedOptionalPlugins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> | undefined {
  return parseOptionalPlugins(env[OPTIONAL_PLUGINS_ENV]);
}
