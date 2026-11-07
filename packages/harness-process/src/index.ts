/**
 * The process helper every harness needs: run one agent command in a process
 * group of its own, watch the wall time and a stalled output stream, and append
 * its JSONL to the step's log. Radian and pi share this shape; only the command
 * and the way one line names a tool call differ.
 */

export * from "./event-note.ts";
export * from "./jsonl-log.ts";
export * from "./process.ts";
