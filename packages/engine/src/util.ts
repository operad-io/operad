/** Small functions that several packages need; each has one definition, here. */

/** Whether the value is a plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The strings of an array value; anything that is not an array gives an empty list. */
export function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The params of a step as an object; `at` names the step in the error. */
export function paramsObject(params: unknown, at: string): Record<string, unknown> {
  if (!isRecord(params)) throw new Error(`${at}: params: must be an object`);
  return params;
}

/** Throws when the value is empty or only spaces; `field` names it in the error. */
export function requireName(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field}: must be a non-empty string`);
  }
}

/**
 * One line: whitespace collapsed, and cut with an ellipsis when a limit is given.
 * The cut keeps a space at its edge unless `trimCut` is set.
 */
export function oneLine(
  text: string,
  limit: number = Number.POSITIVE_INFINITY,
  trimCut = false,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  return `${trimCut ? cut.trimEnd() : cut}…`;
}

/** Calls back every `ms` until the returned function is called; it never keeps the process alive. */
export function repeatEvery(ms: number, callback: () => void): () => void {
  const timer = setInterval(callback, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
  };
}

/**
 * An elapsed duration: at most two units, floored, `<1s` under one second and
 * days from 24 hours; the samples are in `test/fixtures/elapsed.json`.
 */
export function formatElapsed(ms: number): string {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const total = Math.floor(value / 1000);
  if (total < 1) return "<1s";
  const days = Math.floor(total / 86_400);
  if (days > 0) {
    const hours = Math.floor((total % 86_400) / 3_600);
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  const hours = Math.floor(total / 3_600);
  if (hours > 0) {
    const minutes = Math.floor((total % 3_600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(total / 60);
  if (minutes > 0) {
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  return `${total}s`;
}
