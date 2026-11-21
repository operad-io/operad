/**
 * The byte bound of one event-stream line, shared by the presentation kernel
 * that decides what can be pushed and the HTTP server that writes the stream.
 * The iOS app drops a line over 64 KiB, so the kernel stays at that limit and
 * every event fits.
 */

/** The most bytes one line of the event stream may hold, `data: ` included. */
export const MAX_SSE_EVENT_BYTES = 64 * 1024;

/** One `data:` line, or undefined when it would be over the stream's limit. */
export function eventLine(value: unknown): string | undefined {
  const line = `data: ${JSON.stringify(value)}`;
  return Buffer.byteLength(line, "utf8") <= MAX_SSE_EVENT_BYTES
    ? line
    : undefined;
}

/** Whether a live part can be sent without cutting its structured JSON. */
export function fitsEventLine(value: unknown): boolean {
  return eventLine(value) !== undefined;
}
