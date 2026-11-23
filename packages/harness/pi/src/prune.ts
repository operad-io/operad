/**
 * Pruning old tool results from what a model call is sent (T-0767).
 *
 * pi's `context` hook gives each model call a deep copy of the transcript and
 * sends what the hook returns, so the session file and what a person sees stay
 * whole. This file is the decision and the rewrite; `worker.ts` registers it.
 *
 * Why a time rule: every prune rewrites the cached prefix of the prompt. While
 * the provider's cache is alive a prune turns a cheap read into a write; once
 * the cache has expired the whole prefix is rewritten anyway, so shrinking it
 * is free. Why a size rule: a prune that frees little still pays the rewrite,
 * so it waits until it frees enough.
 */

/** What a prune needs; each has a documented default below. */
export interface PruneSettings {
  /** The provider's prompt cache lifetime in ms: the model's own value, else `DEFAULT_CACHE_TTL_MS`. */
  readonly ttlMs: number;
  /** The most recent assistant turns whose tool results are never pruned. */
  readonly keepTurns: number;
  /** Prune only when it frees at least this many characters of tool output. */
  readonly minChars: number;
}

/**
 * The cache lifetime assumed when the model declares none: 5 minutes, the
 * short tier of Anthropic's prompt cache and the conservative end of the
 * providers' ranges.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** The assistant turns kept whole, as OpenClaw's session pruning keeps three. */
export const DEFAULT_KEEP_TURNS = 3;

/**
 * The least a prune must free, in characters of tool output (about 5,000
 * tokens): the value Anthropic's context editing gives as its `clear_at_least`
 * example. pi cuts a built-in tool's output to 2,000 lines or 50 KB (about
 * 12,500 tokens) before it enters the context, so one result frees at most
 * about 50,000 characters and this floor is two fifths of the largest; the
 * tools operad adds (`operad_*`) are not cut by pi and may exceed that. Gemini
 * CLI's 30,000-token floor would be larger than any one built-in result.
 */
export const DEFAULT_MIN_PRUNE_CHARS = 20_000;

/** The text that stands in for a pruned result. */
export function placeholderFor(toolName: string): string {
  return `[${toolName} result removed from the context to save space]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The characters of text a tool result holds; images and other blocks count nothing. */
function textLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") total += block["text"].length;
  }
  return total;
}

function toolNameOf(message: Record<string, unknown>): string {
  const name = message["toolName"];
  return typeof name === "string" && name.length > 0 ? name : "tool";
}

/** The timestamp, in ms, of the last assistant message; undefined when there is none. */
export function lastAssistantAt(messages: readonly unknown[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isRecord(message) && message["role"] === "assistant") {
      const at = message["timestamp"];
      return typeof at === "number" && Number.isFinite(at) ? at : undefined;
    }
  }
  return undefined;
}

export interface PruneOutcome<M> {
  readonly messages: readonly M[];
  /** How many results were replaced. */
  readonly pruned: number;
  /** The characters of tool output the replacement frees. */
  readonly freed: number;
}

/**
 * The messages to send. Nothing is pruned while the cache is alive (`lastAt`
 * within `ttlMs` of `now`; an unknown `lastAt` counts as alive), and nothing
 * when the prune would free less than `minChars`. Otherwise every tool result
 * older than the last `keepTurns` assistant messages and longer than its
 * placeholder becomes the placeholder. The input is not changed.
 */
export function pruneToolResults<M>(
  messages: readonly M[],
  settings: PruneSettings,
  now: number,
  lastAt: number | undefined,
): PruneOutcome<M> {
  const unchanged = { messages, pruned: 0, freed: 0 };
  if (lastAt === undefined || now - lastAt <= settings.ttlMs) return unchanged;
  // The index of the oldest of the kept assistant turns.
  let seen = 0;
  let boundary = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isRecord(message) && message["role"] === "assistant") {
      seen += 1;
      if (seen >= settings.keepTurns) {
        boundary = i;
        break;
      }
    }
  }
  if (seen < settings.keepTurns) return unchanged;
  const replace = new Set<number>();
  let freed = 0;
  for (let i = 0; i < boundary; i += 1) {
    const message = messages[i];
    if (!isRecord(message) || message["role"] !== "toolResult") continue;
    const saved = textLength(message["content"]) - placeholderFor(toolNameOf(message)).length;
    if (saved <= 0) continue;
    replace.add(i);
    freed += saved;
  }
  if (replace.size === 0 || freed < settings.minChars) return unchanged;
  const next = messages.map((message, i) => {
    if (!replace.has(i) || !isRecord(message)) return message;
    // The same message with its content replaced; the id, name and error flag stay.
    const swapped: unknown = { ...message, content: [{ type: "text", text: placeholderFor(toolNameOf(message)) }] };
    return swapped as M;
  });
  return { messages: next, pruned: replace.size, freed };
}
