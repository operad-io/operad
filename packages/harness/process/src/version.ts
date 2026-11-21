/**
 * The version comparison the harness installs share. The strict form reads a
 * full semver and orders prereleases; the lenient form is claude's old numeric
 * dot split, which stays for its CLI's version text. codex's prefix form is
 * lenient in another way: an unreadable version is not compared.
 */

import { compareVersionText, readVersionText } from "@operad-io/engine";

/** What the strict form does with a version it cannot read. */
export interface VersionCompareOptions {
  /** Throw on a version that is not full semver instead of comparing a loose split. */
  readonly strict?: boolean | undefined;
  /** The error for the first version the strict form cannot read. */
  readonly onInvalid?: ((version: string) => Error) | undefined;
}

function looseParts(version: string): readonly number[] {
  return version.split(".").map((part) => Number(part));
}

/** Negative, zero or positive as version `a` is below, equal to or above `b`. */
export function compareVersions(a: string, b: string, options: VersionCompareOptions = {}): number {
  if (options.strict === true) {
    const left = readVersionText(a);
    const right = readVersionText(b);
    if (left === undefined || right === undefined) {
      const bad = left === undefined ? a : b;
      throw options.onInvalid?.(bad) ?? new Error(`not a version: ${bad}`);
    }
    return compareVersionText(left, right);
  }
  const left = looseParts(a);
  const right = looseParts(b);
  for (let at = 0; at < 3; at += 1) {
    const diff = (left[at] ?? 0) - (right[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** A strict comparison whose error for an unreadable version is this harness's. */
export function strictVersionCompare(
  onInvalid: (version: string) => Error,
): (a: string, b: string) => number {
  return (a, b) => compareVersions(a, b, { strict: true, onInvalid });
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
