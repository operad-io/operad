/**
 * New user-visible words. A worker names the ones its change adds in its final
 * answer, the reviewer reports the ones it finds in the diff, and a task that
 * adds a word nobody approved is not merged by itself.
 */

/** The words after `label:` on the last line that starts with it; `none` is no word. */
function wordsOnLine(text: string, label: string): readonly string[] | undefined {
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?${label}:[ \\t]*(.*)$`, "i");
  let found: string | undefined;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const match = pattern.exec(line);
    if (match !== null) found = match[1] ?? "";
  }
  if (found === undefined) return undefined;
  return cleanWords(found.split(","));
}

/** Trimmed, unquoted, deduplicated words; `none` and empty entries drop out. */
export function cleanWords(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const item of items) {
    const word = item.trim().replace(/^[`'"]+|[`'".]+$/g, "").trim();
    if (word.length === 0 || word.toLowerCase() === "none") continue;
    if (seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words;
}

/** The words a worker's final answer names in its `New words:` line. */
export function newWordsOf(finalMessage: string): readonly string[] {
  return wordsOnLine(finalMessage, "New words") ?? [];
}

/** The words a brief marks with `Approved words:` lines. */
export function approvedWordsOf(brief: string): readonly string[] {
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  const words: string[] = [];
  for (const line of lines) {
    words.push(...(wordsOnLine(line, "Approved words") ?? []));
  }
  return cleanWords(words);
}

/** The words that are neither approved by a brief nor already in the user docs. */
export function unapprovedWords(
  named: readonly string[],
  approved: readonly string[],
  docs: string,
): readonly string[] {
  const ok = new Set(approved.map((word) => word.toLowerCase()));
  return cleanWords(named).filter((word) => {
    const key = word.toLowerCase();
    return !ok.has(key) && !docs.includes(key);
  });
}

/** The wait reason for words that need approval. */
export function wordsReason(words: readonly string[]): string {
  return `new words need approval: ${words.join(", ")}`;
}
