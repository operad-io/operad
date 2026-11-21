/**
 * The repository's view of the target grants: list the outward targets a
 * background run may write to without asking, and remove one. The data belongs
 * to the access user layer (ADR 0025 D12); this action only reads and writes
 * it through `@operad-io/access-match`, so the command line and the HTTP/MCP
 * action see the same list.
 */

import type { ActionTypeDefinition } from "@operad-io/engine";
import { isRecord } from "@operad-io/engine";
import { readTargetGrants, revokeTargetGrants, type TargetGrant } from "@operad-io/access-match";

function grantLine(grant: TargetGrant): string {
  const at = Number.isFinite(grant.at) ? new Date(grant.at).toISOString() : "unknown time";
  return `${grant.flow}  ${grant.target}  (${grant.kind})  by ${grant.by.via}:${grant.by.id}  at ${at}`;
}

/** The action that lists the target grants, or removes those of one target. */
export const accessAction: ActionTypeDefinition = {
  name: "allow",
  on: "repo",
  args: {
    type: "object",
    properties: {
      target: {
        type: "string",
        minLength: 1,
        description: "The outward target to stop allowing; omit to list them.",
      },
      flow: {
        type: "string",
        minLength: 1,
        description: "Only remove what this flow allows to the target.",
      },
    },
    additionalProperties: false,
  },
  when() {
    return true;
  },
  async run(ctx, args) {
    const input = isRecord(args) ? args : {};
    const target = typeof input["target"] === "string" ? input["target"] : undefined;
    const flow = typeof input["flow"] === "string" ? input["flow"] : undefined;
    if (target === undefined) {
      const read = await readTargetGrants(ctx.home);
      if (read.problem !== undefined) throw new Error(read.problem);
      if (read.file.grants.length === 0) return "no always-allowed outward targets";
      return read.file.grants.map(grantLine).join("\n");
    }
    const removed = await revokeTargetGrants(ctx.home, target, flow);
    if (removed === 0) {
      return flow === undefined
        ? `no always-allowed target "${target}"`
        : `no always-allowed target "${target}" for the flow "${flow}"`;
    }
    return `removed ${removed} always-allowed target${removed === 1 ? "" : "s"} for "${target}"`;
  },
};
