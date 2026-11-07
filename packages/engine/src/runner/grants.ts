/**
 * One-time permissions. An answered question may give the step that asked a
 * permission for the exact call it asked about. The permission is used up by
 * recording `grant_used` with the question's wait id, before the call runs; the
 * fact is the only record, so a crash after it cannot grant the call twice.
 */

import { SeqConflictError } from "../log/errors.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { Grant } from "../kernel/types.ts";

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The wait ids whose permission the run has used. */
export async function usedGrants(
  log: LogBackend,
  runId: string,
): Promise<ReadonlySet<string>> {
  const used = new Set<string>();
  for await (const fact of log.read(runId)) {
    if (
      fact.kind === "grant_used" &&
      isRecord(fact.payload) &&
      typeof fact.payload.waitId === "string"
    ) {
      used.add(fact.payload.waitId);
    }
  }
  return used;
}

/**
 * Uses up the permission of `waitId`. True when this call used it; false when
 * it was already used or the step has no such permission.
 */
export async function useGrant(
  log: LogBackend,
  runId: string,
  step: string,
  grants: readonly Grant[],
  waitId: string,
): Promise<boolean> {
  const grant = grants.find((item) => item.waitId === waitId);
  if (grant === undefined) return false;
  for (let attempt = 0; ; attempt += 1) {
    let lastSeq = 0;
    let used = false;
    for await (const fact of log.read(runId)) {
      lastSeq = fact.seq;
      if (
        fact.kind === "grant_used" &&
        isRecord(fact.payload) &&
        fact.payload.waitId === waitId
      ) {
        used = true;
      }
    }
    if (used) return false;
    try {
      await log.append(runId, lastSeq, [
        {
          kind: "grant_used",
          payload: {
            waitId,
            step,
            kind: grant.kind,
            value: grant.value,
            ...(grant.tool === undefined ? {} : { tool: grant.tool }),
          },
          cause: lastSeq >= 1 ? lastSeq : "grant",
        },
      ]);
      return true;
    } catch (error) {
      if (error instanceof SeqConflictError && attempt < 8) continue;
      throw error;
    }
  }
}

/** The run's access profile with the permissions that are still unused. */
export function accessWith(
  access: JsonValue,
  grants: readonly Grant[] | undefined,
  used: ReadonlySet<string>,
): JsonValue {
  const open = (grants ?? []).filter((grant) => !used.has(grant.waitId));
  if (open.length === 0) return access;
  return {
    ...(isRecord(access) ? access : {}),
    grants: open.map((grant) => ({ ...grant })),
  };
}
