/** How a document becomes searchable chunks and a snippet a reader can scan. */

/** One slice of a document, with the lines it covers (1-based). */
export interface TextChunk {
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** How many lines one chunk holds, and how many it repeats from the last. */
export const CHUNK_LINES = 20;
export const CHUNK_OVERLAP = 2;

/** The number of lines a text has, with 0 for empty text. */
export function lineCountOf(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/u).length;
}

/**
 * Splits text into overlapping line windows. The overlap keeps a phrase that
 * straddles a chunk boundary reachable; line numbers are the document's own.
 */
export function chunksOf(
  text: string,
  maxLines: number = CHUNK_LINES,
  overlap: number = CHUNK_OVERLAP,
): readonly TextChunk[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/u);
  const limit = Math.max(1, maxLines);
  const step = Math.max(1, limit - Math.max(0, overlap));
  const chunks: TextChunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + limit);
    const textOfChunk = lines.slice(start, end).join("\n");
    if (textOfChunk.trim().length > 0) {
      chunks.push({ text: textOfChunk, lineStart: start + 1, lineEnd: end });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

/**
 * A short piece of text around the first term it contains. The markers say
 * where the snippet was cut, not where the match is: a reader sees the lines a
 * result points at.
 */
export function snippetOf(text: string, terms: readonly string[], width: number = 180): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= width) return flat;
  let at = -1;
  for (const term of terms) {
    if (term.length === 0) continue;
    const found = flat.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) at = 0;
  const half = Math.floor(width / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Splits a query into terms. Whitespace and common punctuation separate them;
 * a run of Chinese characters with no separator stays one term, which is what a
 * phrase search needs. The caller decides which terms the tokenizer can use.
 */
export function queryTerms(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.split(/[\s,，.。;；:：!！?？()（）[\]【】{}"'“”‘’、/\\|]+/u);
  const terms: string[] = [];
  for (const part of parts) {
    const term = part.trim();
    if (term.length > 0 && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

/** The number of Unicode characters in a term, which trigram counts. */
export function characterLength(term: string): number {
  return [...term].length;
}
