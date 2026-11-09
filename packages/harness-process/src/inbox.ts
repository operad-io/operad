/**
 * A way for the host to say something to an agent that is already running.
 *
 * `dev` hands a harness step an object under `params.inbox` with one method,
 * `listen(handler)`. The handler gets each message the host sends, in order,
 * including the ones sent before it listened; the returned function stops
 * listening. A harness that can take a message mid-run listens and passes the
 * text on; one that cannot ignores the field and the run goes on without it.
 */
export interface MessageInbox {
  listen(handler: (text: string) => void): () => void;
  /**
   * Tells the host the run has begun and how long it may last, in
   * milliseconds, so it can time what it says from the run's own start.
   */
  begin?(limitMs: number): void;
}

/** The inbox in a step's params, or undefined when the host gave none. */
export function inboxOf(params: unknown): MessageInbox | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const inbox: unknown = Reflect.get(params, "inbox");
  if (typeof inbox !== "object" || inbox === null) return undefined;
  return typeof Reflect.get(inbox, "listen") === "function"
    ? (inbox as MessageInbox)
    : undefined;
}

/** The stdin line a worker program reads as a message from the host. */
export function messageLine(text: string): string {
  return JSON.stringify({ type: "message", text });
}

/** The text of a `message` stdin line, or undefined for any other line. */
export function messageText(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    if (Reflect.get(value, "type") !== "message") return undefined;
    const text: unknown = Reflect.get(value, "text");
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}
