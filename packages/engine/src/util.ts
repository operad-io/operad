/** Small functions that several packages need; each has one definition, here. */

import { stat } from "node:fs/promises";
import type { ObjectRef } from "./plugin/types.ts";

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

/** Text cut to at most `max` characters, with an ellipsis at the cut. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The type and id a typed object id names, or undefined when it is not one.
 * `flow:<plugin>/<flow>` is not special here; a caller that owns it refuses it.
 */
export function parseObjectId(
  key: string,
  options: { readonly allowEmptyId?: boolean | undefined } = {},
): { readonly type: string; readonly id: string } | undefined {
  const at = key.indexOf(":");
  if (at <= 0) return undefined;
  if (at === key.length - 1 && options.allowEmptyId !== true) return undefined;
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

/** The id without its type: `item:T-1` becomes `T-1`; an untyped id is unchanged. */
export function bareId(id: string): string {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
}

/** The key of an object: `type:id`, or `flow` when a run names no object. */
export function objectKey(object: ObjectRef | undefined): string;
/** The key of an object from its type and id: `type:id`. */
export function objectKey(type: string, id: string): string;
export function objectKey(object: ObjectRef | string | undefined, id?: string): string {
  if (typeof object === "string") return `${object}:${id ?? ""}`;
  return object === undefined ? "flow" : `${object.type}:${object.id}`;
}

/** The `name` a plugin definition declares, when it declares one. */
export function definitionName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("name" in value)) return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** The reason a directory cannot be a working directory, if it cannot. */
export async function directoryError(cwd: string): Promise<string | undefined> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? undefined : `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
}

/** The `code` a filesystem error carries, or undefined. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** True when the error says the file does not exist. */
export function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
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

/** The `guide` path a plugin definition declares, when it declares one. */
export function definitionGuide(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("guide" in value)) return undefined;
  const guide = (value as { guide?: unknown }).guide;
  return typeof guide === "string" ? guide : undefined;
}
