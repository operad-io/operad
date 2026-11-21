import { isRecord } from "@operad-io/engine";

/** The edge a task took into a step that handles a stop, as the flow names it. */
export interface EdgeParams {
  readonly from: string;
  readonly result: string;
  /** The choices the wait that follows offers; present when this step asks for it. */
  readonly choices?: readonly string[] | undefined;
}

/** Reads an edge's params, defaulting a missing or malformed value to empty. */
export function edgeParamsOf(params: unknown): EdgeParams {
  const record = isRecord(params) ? params : {};
  const from = typeof record.from === "string" ? record.from : "";
  const result = typeof record.result === "string" ? record.result : "";
  const choices =
    Array.isArray(record.choices) &&
    record.choices.every((choice): choice is string => typeof choice === "string")
      ? record.choices
      : undefined;
  return { from, result, ...(choices === undefined ? {} : { choices }) };
}
