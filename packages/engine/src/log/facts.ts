/** Validation and id derivation shared by the log backends. */

import { InvalidPayloadError } from "./errors.ts";
import { assertJsonValue } from "./json-value.ts";
import type { NewFact } from "./types.ts";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function assertName(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidPayloadError(`${label} must be a non-empty string`);
  }
}

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) {
    throw new InvalidPayloadError(`invalid run id ${JSON.stringify(runId)}`);
  }
}

export function assertExpectedSeq(expectedSeq: number): void {
  if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
    throw new InvalidPayloadError("expectedSeq must be a non-negative integer");
  }
}

export function validateNewFact(fact: NewFact): void {
  if (typeof fact !== "object" || fact === null) {
    throw new InvalidPayloadError("a fact must be an object");
  }
  if (typeof fact.kind !== "string" || fact.kind.length === 0) {
    throw new InvalidPayloadError("a fact must have a non-empty kind");
  }
  if (typeof fact.cause === "number") {
    if (!Number.isInteger(fact.cause) || fact.cause < 1) {
      throw new InvalidPayloadError("a numeric fact cause must be a positive sequence number");
    }
  } else if (typeof fact.cause !== "string" || fact.cause.length === 0) {
    throw new InvalidPayloadError("a fact cause must be a sequence number or an input id");
  }
  assertJsonValue(fact.payload, "fact payload");
}

function inputKey(source: string, sourceKey: string): string {
  return JSON.stringify([source, sourceKey]);
}

export function inputIdFor(source: string, sourceKey: string): string {
  return `input_${Buffer.from(inputKey(source, sourceKey), "utf8").toString("base64url")}`;
}
