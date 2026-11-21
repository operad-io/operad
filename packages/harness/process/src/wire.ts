/**
 * The wire shapes and the input checks the claude and pi child programs share.
 * Each program keeps its own input and output where they differ; these are the
 * fields both read the same way and the messages both give for a wrong one.
 */

import { readProfile } from "@operad-io/access-match";
import { isRecord } from "@operad-io/engine";
import { parseImageInputs, type ImageInput } from "./images.ts";
import type { WorkerKeep } from "./keep.ts";

/** What one model call used, as both workers report it. */
export interface WorkerUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export type WorkerResultName = "done" | "failed" | "cancelled";

/**
 * A stdin line after the input: the host's answer to an `ask_call` line.
 * `allow` lets this one call run; `deny` refuses it; `stop` means the wait
 * ended and the program is about to be ended: it holds the call.
 */
export interface AskAck {
  readonly type: "ask_ack";
  readonly id: number;
  readonly decision: "allow" | "deny" | "stop";
  readonly reason?: string;
}

/** A stdin line after the input: the host's answer to a `grant_use` line. */
export interface GrantAck {
  readonly type: "grant_ack";
  readonly id: number;
  readonly used: boolean;
}

/** One field read: its value, or the message that names what is wrong. */
export type FieldRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function failed<T>(message: string): FieldRead<T> {
  return { ok: false, message };
}

function read<T>(value: T): FieldRead<T> {
  return { ok: true, value };
}

/** Refuses a field the program does not know, never ignoring it. */
export function readUnknownFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): FieldRead<undefined> {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) return failed(`${key} is not an input field`);
  }
  return read(undefined);
}

/** Reads fields that must be non-empty strings. */
export function readRequiredStrings(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): FieldRead<Readonly<Record<string, string>>> {
  const strings: Record<string, string> = {};
  for (const field of fields) {
    const found = value[field];
    if (found === undefined) return failed(`${field} is required`);
    if (typeof found !== "string" || found.length === 0) {
      return failed(`${field} must be a non-empty string`);
    }
    strings[field] = found;
  }
  return read(strings);
}

/** Reads a field that is a non-empty string when it is there. */
export function readOptionalString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): FieldRead<string | undefined> {
  const found = value[field];
  if (found === undefined) return read(undefined);
  if (typeof found !== "string" || found.length === 0) {
    return failed(`${field} must be a non-empty string`);
  }
  return read(found);
}

/** Reads a field that is a boolean when it is there. */
export function readBoolean(
  value: Readonly<Record<string, unknown>>,
  field: string,
): FieldRead<boolean | undefined> {
  const found = value[field];
  if (found === undefined) return read(undefined);
  if (typeof found !== "boolean") return failed(`${field} must be a boolean`);
  return read(found);
}

/** Reads a field that is a positive integer when it is there. */
export function readPositiveInteger(
  value: Readonly<Record<string, unknown>>,
  field: string,
): FieldRead<number | undefined> {
  const found = value[field];
  if (found === undefined) return read(undefined);
  if (typeof found !== "number" || !Number.isInteger(found) || found < 1) {
    return failed(`${field} must be a positive integer`);
  }
  return read(found);
}

/** Reads a field that is a positive number when it is there. */
export function readPositiveNumber(
  value: Readonly<Record<string, unknown>>,
  field: string,
): FieldRead<number | undefined> {
  const found = value[field];
  if (found === undefined) return read(undefined);
  if (typeof found !== "number" || !Number.isFinite(found) || found <= 0) {
    return failed(`${field} must be a positive number`);
  }
  return read(found);
}

/** Reads a field that is an array of strings when it is there. */
export function readStringList(
  value: Readonly<Record<string, unknown>>,
  field: string,
): FieldRead<readonly string[] | undefined> {
  const found = value[field];
  if (found === undefined) return read(undefined);
  if (!Array.isArray(found) || !found.every((item) => typeof item === "string")) {
    return failed(`${field} must be an array of strings`);
  }
  return read(found as readonly string[]);
}

/** Reads the secret values a log line masks. */
export function readSecrets(value: Readonly<Record<string, unknown>>): FieldRead<readonly string[] | undefined> {
  return readStringList(value, "secretValues");
}

/** Reads the images a prompt carries, from their files. */
export function readImages(value: Readonly<Record<string, unknown>>): FieldRead<readonly ImageInput[]> {
  const images = parseImageInputs(value["images"]);
  return typeof images === "string" ? failed(images) : read(images);
}

/** Reads operad's own tools, served from one home. */
export function readOperadTools(
  value: Readonly<Record<string, unknown>>,
): FieldRead<{ readonly home: string } | undefined> {
  const found = value["operadTools"];
  if (found === undefined) return read(undefined);
  if (!isRecord(found) || typeof found["home"] !== "string" || found["home"].length === 0) {
    return failed("operadTools must be an object with a home");
  }
  return read({ home: String(found["home"]) });
}

/** Reads an access profile, naming the field the profile refuses. */
export function readAccess(
  value: Readonly<Record<string, unknown>>,
): FieldRead<Readonly<Record<string, unknown>> | undefined> {
  const found = value["access"];
  if (found === undefined) return read(undefined);
  if (!isRecord(found)) return failed("access must be an object");
  const profile = readProfile(found);
  if (!profile.ok) return failed(`access.${profile.message}`);
  return read(found);
}

/** Reads the request to keep the worker after this reply. */
export function readKeep(value: Readonly<Record<string, unknown>>): FieldRead<WorkerKeep | undefined> {
  const found = value["keep"];
  if (found === undefined) return read(undefined);
  if (!isRecord(found)) return failed("keep must be an object");
  const fields: Record<string, string> = {};
  for (const field of ["socket", "meta", "token", "scope", "key"] as const) {
    const field_ = found[field];
    if (typeof field_ !== "string" || field_.length === 0) {
      return failed(`keep.${field} must be a non-empty string`);
    }
    fields[field] = field_;
  }
  const timeoutMs = found["timeoutMs"];
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failed("keep.timeoutMs must be a positive number");
  }
  return read({
    socket: fields["socket"] ?? "",
    meta: fields["meta"] ?? "",
    token: fields["token"] ?? "",
    scope: fields["scope"] ?? "",
    key: fields["key"] ?? "",
    timeoutMs,
  });
}
