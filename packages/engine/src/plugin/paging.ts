/** Shared paging, cursor and `where` rules for the object stores. */

import type { ObjectData } from "./types.ts";
import { isRecord } from "../util.ts";

/** The number of objects or facts one page holds when the caller names none. */
export const DEFAULT_PAGE_LIMIT = 100;

/** The largest page any caller may ask for. */
export const MAX_PAGE_LIMIT = 1000;

/** A cursor is not one this store made for this call. */
export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

/** A `where` filter names a field the object type did not declare. */
export class WhereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhereError";
  }
}

function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** The limit a page uses: 100 by default, no more than 1000. */
export function pageLimit(value: number | undefined, field = "limit"): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field}: must be a positive integer`);
  }
  return Math.min(value, MAX_PAGE_LIMIT);
}

/** A stable text form of a JSON value, used to compare filter values. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? "null";
}

/** The fingerprint a list cursor carries, so a filter cannot be swapped. */
export function whereFingerprint(where: Readonly<Record<string, unknown>>): string {
  return canonical(where);
}

/** Refuses a filter on a field the type did not declare in `index`. */
export function assertWhere(
  index: readonly string[],
  where: Readonly<Record<string, unknown>> | undefined,
  label: string,
): void {
  if (where === undefined) return;
  if (!isRecord(where)) {
    throw new WhereError(`${label}: where: must be an object of field: value filters`);
  }
  const allowed = new Set(index);
  for (const [field, value] of Object.entries(where)) {
    if (!allowed.has(field)) {
      const fields =
        index.length === 0
          ? "this type declares no index"
          : `indexed fields are ${index.map((item) => `"${item}"`).join(", ")}`;
      throw new WhereError(
        `${label}: where: field "${field}" is not indexed; ${fields}`,
      );
    }
    if (!isJsonScalar(value)) {
      throw new WhereError(
        `${label}: where.${field}: must be a string, number, boolean or null`,
      );
    }
  }
}

/** True when every filter field equals the object's field. */
export function matchesWhere(
  data: ObjectData,
  where: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (where === undefined) return true;
  for (const [field, value] of Object.entries(where)) {
    if (canonical(data[field]) !== canonical(value)) return false;
  }
  return true;
}

/** Encodes an opaque cursor that a client only passes back. */
export function encodeCursor(payload: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decodes a cursor and names the call when it is not one this store made. */
export function decodeCursor(
  cursor: string,
  label: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new CursorError(`${label}: invalid cursor`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CursorError(`${label}: invalid cursor`);
  }
  if (!isRecord(value)) {
    throw new CursorError(`${label}: invalid cursor`);
  }
  return value;
}
