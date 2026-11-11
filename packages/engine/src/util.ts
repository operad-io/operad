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

/** One line: whitespace collapsed, and cut with an ellipsis when a limit is given. */
export function oneLine(text: string, limit: number = Number.POSITIVE_INFINITY): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** Calls back every `ms` until the returned function is called; it never keeps the process alive. */
export function repeatEvery(ms: number, callback: () => void): () => void {
  const timer = setInterval(callback, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
  };
}
