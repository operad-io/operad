/**
 * Reduces an assistant reply's Markdown to what Telegram accepts, and splits a
 * long reply. Telegram's HTML subset is used because escaping it is mechanical:
 * `b`, `i`, `code`, `pre`, `a`, `blockquote`. Everything else (headings, lists,
 * tables, images, HTML) becomes plain text or one of those.
 */

/** The longest text Telegram takes in one message. */
export const TELEGRAM_MAX_CHARS = 4096;

/** The source length a chunk aims at, below the limit so markup has room. */
const CHUNK_TARGET = 3500;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Inline Markdown of one line as Telegram HTML. */
function inline(text: string): string {
  const parts: string[] = [];
  const hold = (html: string): string => {
    parts.push(html);
    return `\u0000${parts.length - 1}\u0000`;
  };
  let work = text.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  work = work.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    /^(https?:|tg:|mailto:)/i.test(url)
      ? hold(`<a href="${escapeAttribute(url)}">${escapeHtml(label.length === 0 ? url : label)}</a>`)
      : hold(escapeHtml(label.length === 0 ? url : label)),
  );
  work = escapeHtml(work);
  work = work.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<b>${a ?? b ?? ""}</b>`);
  work = work.replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=$|[\s).,;:!?])/g, (_m, lead: string, body: string) => `${lead}<i>${body}</i>`);
  work = work.replace(/(^|[\s(])_([^_\s][^_\n]*)_(?=$|[\s).,;:!?])/g, (_m, lead: string, body: string) => `${lead}<i>${body}</i>`);
  work = work.replace(/~~([^~\n]+)~~/g, "$1");
  return work.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => parts[Number(index)] ?? "");
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([^`\s]*)\s*$/;

/** Telegram HTML for one chunk of Markdown. */
export function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = [];
  let fence: { readonly marker: string; readonly lines: string[] } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const match = FENCE.exec(line);
    if (fence !== undefined) {
      if (match !== null && line.trim().startsWith(fence.marker[0] ?? "`") && (match[1]?.length ?? 0) >= fence.marker.length && (match[2] ?? "") === "") {
        out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (match !== null) {
      fence = { marker: match[1] ?? "```", lines: [] };
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      out.push(`<b>${inline(heading[1] ?? "")}</b>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("――――");
      continue;
    }
    const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (item !== null) {
      out.push(`${item[1] ?? ""}• ${inline(item[2] ?? "")}`);
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote !== null) {
      out.push(`▎${inline(quote[1] ?? "")}`);
      continue;
    }
    out.push(inline(line));
  }
  if (fence !== undefined) out.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Splits Markdown into pieces of at most `limit` characters, never inside a fence without closing it. */
export function splitMarkdown(markdown: string, limit: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fence: string | undefined;
  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join("\n");
    chunks.push(fence === undefined ? body : `${body}\n\`\`\``);
    current = fence === undefined ? [] : [fence];
    size = fence === undefined ? 0 : fence.length + 1;
  };
  for (const original of markdown.split(/\r?\n/)) {
    // A line longer than the limit is cut; the cut ignores word boundaries.
    const pieces: string[] = [];
    for (let at = 0; at < Math.max(original.length, 1); at += limit - 8) pieces.push(original.slice(at, at + limit - 8));
    for (const line of pieces) {
      if (size + line.length + 1 > limit - 4 && current.length > 0 && !(current.length === 1 && fence !== undefined)) flush();
      current.push(line);
      size += line.length + 1;
      const match = FENCE.exec(line);
      if (match !== null) fence = fence === undefined ? line : undefined;
    }
  }
  if (current.length > 0 && !(current.length === 1 && fence !== undefined && chunks.length > 0)) {
    chunks.push(current.join("\n"));
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** One message ready to send: the HTML Telegram takes and the Markdown it came from. */
export interface TelegramChunk {
  readonly html: string;
  /** The Markdown of this piece, sent as plain text if Telegram refuses the HTML. */
  readonly plain: string;
}

/** A reply as the messages to send, each within Telegram's limit. */
export function telegramChunks(markdown: string, limit = CHUNK_TARGET): readonly TelegramChunk[] {
  const out: TelegramChunk[] = [];
  for (const piece of splitMarkdown(markdown, limit)) {
    const html = markdownToTelegramHtml(piece);
    if (html.length > TELEGRAM_MAX_CHARS && limit > 64) {
      out.push(...telegramChunks(piece, Math.floor(limit / 2)));
    } else if (html.length > 0) {
      out.push({ html, plain: piece.slice(0, TELEGRAM_MAX_CHARS) });
    }
  }
  return out;
}
