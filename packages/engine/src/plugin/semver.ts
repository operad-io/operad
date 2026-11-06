/**
 * The small semver range check a plugin declaration needs: `^`, `~`, `>=`
 * and an exact version. No dependency, no prerelease or `||` support.
 */

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compare(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function atLeast(value: Version, base: Version): boolean {
  return compare(value, base) >= 0;
}

function below(value: Version, base: Version): boolean {
  return compare(value, base) < 0;
}

/** The upper bound of a caret range, following the usual zero-major rule. */
function caretUpper(base: Version): Version {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

/** The upper bound of a tilde range: the next minor, or the next major for `~1`. */
function tildeUpper(text: string, base: Version): Version {
  const parts = text.trim().split(".");
  if (parts.length <= 1) return { major: base.major + 1, minor: 0, patch: 0 };
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

function matchesOne(version: Version, range: string): boolean {
  const text = range.trim();
  if (text.length === 0) return false;

  if (text.startsWith("^")) {
    const base = parseVersion(text.slice(1));
    if (base === undefined) return false;
    return atLeast(version, base) && below(version, caretUpper(base));
  }
  if (text.startsWith("~")) {
    const baseText = text.slice(1);
    const base = parseVersion(baseText);
    if (base === undefined) return false;
    return atLeast(version, base) && below(version, tildeUpper(baseText, base));
  }
  if (text.startsWith(">=")) {
    const base = parseVersion(text.slice(2));
    return base === undefined ? false : atLeast(version, base);
  }
  if (text.startsWith("=")) {
    const exact = parseVersion(text.slice(1));
    return exact === undefined ? false : compare(version, exact) === 0;
  }
  const exact = parseVersion(text);
  return exact === undefined ? false : compare(version, exact) === 0;
}

/** Whether `version` satisfies `range`, or throws when the range is malformed. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    throw new Error(`version "${version}" is not a version`);
  }
  const parts = range.split("||").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new Error(`range "${range}" is empty`);
  }
  for (const part of parts) {
    if (!isRangeSyntax(part)) {
      throw new Error(`range "${range}" is not supported; use ^, ~, >= or an exact version`);
    }
  }
  return parts.some((part) => matchesOne(parsed, part));
}

/** The shape check `satisfiesRange` uses, so a bad declaration is named early. */
export function isRangeSyntax(range: string): boolean {
  const parts = range.split("||").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return false;
  return parts.every((part) => {
    const text = part.startsWith("^") || part.startsWith("~")
      ? part.slice(1)
      : part.startsWith(">=")
        ? part.slice(2)
        : part.startsWith("=")
          ? part.slice(1)
          : part;
    return parseVersion(text) !== undefined;
  });
}
