/**
 * The load readings `remote-check.sh` writes into a check log. A check that
 * runs here uses the reader in `notcode.ts`; a check on the test host carries
 * its own readings back, so dev judges the machine the command ran on.
 */

import type { MachineLoad } from "@operad-io/engine/platform";

/** A load reading, with the host it came from when the check ran elsewhere. */
export interface CheckLoadReading extends MachineLoad {
  readonly host?: string | undefined;
  /** Set when the host could not read its own load; it is judged as quiet. */
  readonly unknown?: boolean | undefined;
}

/** The load when one run of a command started and when it ended. */
export interface CheckLoad {
  readonly start: CheckLoadReading;
  readonly end: CheckLoadReading;
}

const LOAD_LINE = /^remote-check: load (?:(?<load1>\d+(?:\.\d+)?) on (?<cores>\d+) cores|unknown) on (?<host>.+?)\s*$/;

/** The readings in one run's part of a check log; undefined when it ran here. */
export function loadsFromLog(text: string): CheckLoad | undefined {
  const known: CheckLoadReading[] = [];
  let unknownHost: string | undefined;
  let sawLine = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const found = LOAD_LINE.exec(line);
    if (found === null) continue;
    sawLine = true;
    const load1 = found.groups?.load1;
    const cores = found.groups?.cores;
    const host = found.groups?.host?.trim();
    if (load1 !== undefined && cores !== undefined) {
      known.push({
        load1: Number(load1),
        cores: Number(cores),
        ...(host === undefined || host === "" ? {} : { host }),
      });
    } else {
      unknownHost = host === undefined || host === "" ? undefined : host;
    }
  }
  if (!sawLine) return undefined;
  if (unknownHost !== undefined || known.length === 0) {
    const reading: CheckLoadReading = {
      load1: 0,
      cores: 0,
      ...(unknownHost === undefined ? {} : { host: unknownHost }),
      unknown: true,
    };
    return { start: reading, end: reading };
  }
  const first = known[0];
  const last = known[known.length - 1];
  return first === undefined || last === undefined ? undefined : { start: first, end: last };
}

/**
 * A load reading as a history line says it: `under load 23.8 on 16 cores on
 * host`, or `under load unknown on host`. `shown` keeps a line's own rounding.
 */
export function underLoad(load: CheckLoadReading, shown = String(load.load1)): string {
  if (load.unknown === true) {
    return load.host === undefined ? "under load unknown" : `under load unknown on ${load.host}`;
  }
  const host = load.host === undefined ? "" : ` on ${load.host}`;
  return `under load ${shown} on ${load.cores} cores${host}`;
}
