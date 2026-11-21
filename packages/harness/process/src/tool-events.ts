/**
 * The line the claude and pi workers write when a tool call starts or ends.
 * The stall timer holds while a call is open; both programs name it under the
 * same `type`, so one classifier reads both.
 */

import { isRecord } from "@operad-io/engine";
import type { ToolEvent } from "./process.ts";

/** The tool call one worker line starts or settles, or undefined for another line. */
export function toolExecutionEvent(line: string): ToolEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "tool_execution_start") return "tool-start";
  if (value.type === "tool_execution_end") return "tool-end";
  return undefined;
}
