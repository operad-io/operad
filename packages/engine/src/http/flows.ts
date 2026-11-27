/** The start by hand a client of `serve` reaches; the caller of the server supplies it. */

import type { Actor } from "../plugin/types.ts";

export interface FlowStarted {
  readonly flow: string;
  readonly runId: string;
}

/**
 * What the HTTP interface calls to start a flow once. The caller supplies it,
 * so the answers and refusals are the command line's. A refusal is a
 * `ViewError`.
 */
export interface FlowStarter {
  start(flow: string, params: unknown, actor: Actor): Promise<FlowStarted>;
}
