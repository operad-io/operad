/**
 * The part of Markdown a search reads: frontmatter as fields for a filter, and
 * the body as text for the index. The parser is deliberately small: the keys
 * and values a note uses for its title, tags and dates. A structure it does not
 * understand is left out of the fields rather than guessed at.
 */

import type { DocumentFields } from "./types.ts";

/** A body with the fields its frontmatter stated. */
export interface SplitMarkdown {
  readonly fields: DocumentFields;
  readonly body: string;
}

const KEY = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function scalar(value: string): string {
  const text = unquote(value);
  // A comment after an unquoted scalar is not part of it. A `#` inside a note
  // tag or a colour would be, so only a space before it starts a comment.
  return text.replace(/\s+#.*$/u, "").trim();
}

function list(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  return inner
    .split(",")
    .map((item) => scalar(item))
    .filter((item) => item.length > 0);
}

/**
 * Splits Markdown into its frontmatter fields and the body that follows. Text
 * without a closed frontmatter block is all body.
 */
export function splitMarkdown(raw: string): SplitMarkdown {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fields: {}, body: text };
  }
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) return { fields: {}, body: text };

  const found = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const item = /^-\s*(.*)$/u.exec(trimmed);
    if (item !== null && current !== undefined) {
      const value = scalar(item[1] ?? "");
      if (value.length > 0) found.get(current)?.push(value);
      continue;
    }
    const match = KEY.exec(line);
    if (match === null) {
      current = undefined;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    current = key;
    const values = found.get(key) ?? [];
    if (value.startsWith("[") && value.endsWith("]")) {
      values.push(...list(value));
    } else if (value.length > 0) {
      const one = scalar(value);
      if (one.length > 0) values.push(one);
    }
    found.set(key, values);
  }

  const fields: Record<string, readonly string[]> = {};
  for (const [key, values] of found) {
    // A key with no value (a block list that had no items) is not a filter.
    if (values.length > 0) fields[key.toLowerCase()] = [...values];
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** The title a reader sees: frontmatter `title`, a heading, or the file name. */
export function titleOf(fields: DocumentFields, body: string, fallback: string): string {
  const stated = fields["title"]?.[0];
  if (stated !== undefined && stated.length > 0) return stated;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading !== null && heading[1] !== undefined && heading[1].length > 0) return heading[1];
  }
  return fallback;
}

/** A file name without its Markdown extension. */
export function titleFromName(name: string): string {
  return name.replace(/\.(?:md|markdown)$/iu, "");
}
