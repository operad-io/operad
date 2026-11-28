/**
 * The check answer for an agent that is on the machine and cannot be used until
 * the person acts: it is signed out, or older than the harness's floor. The
 * check passes and reports it as missing (ADR 0022 D14), under the item name
 * every setup guide has a step for.
 */

import type { PluginCheckReturn } from "@operad-io/engine";

export function agentNotSetUp(reason: string): PluginCheckReturn {
  return { note: `not set up: ${reason}`, missing: [{ name: "check", description: reason }] };
}
