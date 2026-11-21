/**
 * The version comparison the harness installs share. One strict form reads a
 * full semver and orders prereleases; codex's prefix form is lenient in another
 * way: an unreadable version is not compared.
 */

import { compareVersionText, readVersionText } from "@operad-io/engine";

/** Negative, zero or positive as version `a` is below, equal to or above `b`. */
export function compareVersions(
  a: string,
  b: string,
  onInvalid?: ((version: string) => Error) | undefined,
): number {
  const left = readVersionText(a);
  const right = readVersionText(b);
  if (left === undefined || right === undefined) {
    const bad = left === undefined ? a : b;
    throw onInvalid?.(bad) ?? new Error(`not a version: ${bad}`);
  }
  return compareVersionText(left, right);
}

/** A strict comparison whose error for an unreadable version is this harness's. */
export function strictVersionCompare(
  onInvalid: (version: string) => Error,
): (a: string, b: string) => number {
  return (a, b) => compareVersions(a, b, onInvalid);
}

/** The first three numbers of a version, as codex reports them; undefined when it has none. */
function versionPrefix(version: string): readonly [number, number, number] | undefined {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (found === null) return undefined;
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** Whether `version` is at least `floor`; an unreadable version is not compared. */
export function versionAtLeast(version: string, floor: string): boolean {
  const left = versionPrefix(version);
  const right = versionPrefix(floor);
  if (left === undefined || right === undefined) return true;
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
