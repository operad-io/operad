/**
 * A small terminal renderer for the one content type the kernel has: Markdown
 * with GFM tables and fenced code. With `colour` it styles headings, emphasis,
 * links, code and tables for a terminal; without it the output is plain text.
 * It draws no plugin colours, and it never decides layout: headings become
 * bold, a diff gets red and green lines, every other fence stays code.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
} as const;

export interface RenderOptions {
  /** Add ANSI styling, for a terminal; off by default. */
  readonly colour?: boolean | undefined;
}

/** One rendered line. `code` marks a fenced code line, including its label. */
export interface MarkdownLine {
  readonly text: string;
  readonly code: boolean;
}

function styled(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_]+)_/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1");
}

/** Styles inline text without changing what a terminal shows. */
function styledInline(text: string): string {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return styled(part.slice(1, -1), ANSI.cyan);
      }
      return styledPlainInline(part);
    })
    .join("");
}

function styledPlainInline(text: string): string {
  return text
    .replace(
      /!\[([^\]]*)\]\([^)]*\)/g,
      (_match, alt: string) => styled(alt, ANSI.dim),
    )
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_match, label: string, url: string) =>
        `${styled(label, `${ANSI.underline}${ANSI.cyan}`)} ${styled(`(${url})`, ANSI.dim)}`,
    )
    .replace(
      /\*\*([^*]+)\*\*/g,
      (_match, body: string) => styled(body, ANSI.bold),
    )
    .replace(
      /__([^_]+)__/g,
      (_match, body: string) => styled(body, ANSI.bold),
    )
    .replace(
      /(^|[^*])\*([^*]+)\*/g,
      (_match, lead: string, body: string) => `${lead}${styled(body, ANSI.italic)}`,
    )
    .replace(
      /(^|[^_])_([^_]+)_/g,
      (_match, lead: string, body: string) => `${lead}${styled(body, ANSI.italic)}`,
    )
    .replace(
      /~~([^~]+)~~/g,
      (_match, body: string) => styled(body, `\x1b[9m`),
    );
}

function renderInline(text: string, colour: boolean): string {
  return colour ? styledInline(text) : stripInline(text);
}

function visibleLength(text: string): number {
  return [...stripInline(text)].length;
}

/** An opening fence: its character, length and language (the info string's first word). */
interface Fence {
  readonly char: string;
  readonly length: number;
  readonly language: string;
}

/** Reads an opening fence per CommonMark: 3+ backticks or tildes, indented at most 3 spaces. */
function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const run = match[1] ?? "";
  const info = (match[2] ?? "").trim();
  // A backtick fence's info string may not contain a backtick.
  if (run.startsWith("`") && info.includes("`")) return undefined;
  return {
    char: run.charAt(0),
    length: run.length,
    language: info.split(/\s+/)[0] ?? "",
  };
}

/** A closing fence: the same character, at least as long, then only spaces. */
function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line);
  const run = match?.[1];
  return run !== undefined && run.charAt(0) === fence.char && run.length >= fence.length;
}

function splitCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function renderTable(rows: readonly string[], colour: boolean): string[] {
  const cells = rows.map(splitCells);
  const width = Math.max(1, ...cells.map((row) => row.length));
  const widths: number[] = [];
  for (let index = 0; index < width; index += 1) {
    widths.push(
      Math.max(
        1,
        ...cells.map((row) => visibleLength(row[index] ?? "")),
      ),
    );
  }

  const draw = (row: readonly string[], separator: string): string => {
    const parts: string[] = [];
    for (let index = 0; index < width; index += 1) {
      const cell = row[index] ?? "";
      const length = visibleLength(cell);
      const text = renderInline(cell, colour);
      parts.push(`${text}${" ".repeat(Math.max(0, (widths[index] ?? 1) - length))}`);
    }
    return `${separator} ${parts.join(` ${separator} `)} ${separator}`.replace(
      /\s+$/,
      "",
    );
  };

  const lines: string[] = [];
  const header = cells[0] ?? [];
  lines.push(draw(header, "|"));
  const rule = `|${widths.map((size) => "-".repeat(size + 2)).join("|")}|`;
  lines.push(colour ? styled(rule, ANSI.dim) : rule);
  for (const row of cells.slice(1)) {
    if (isTableSeparator(row.join("|"))) continue;
    lines.push(draw(row, "|"));
  }
  return lines;
}

function renderCode(
  language: string,
  code: readonly string[],
  colour: boolean,
): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  if (language.length > 0) {
    lines.push({
      text: colour ? styled(`  ${language}`, ANSI.dim) : `  ${language}`,
      code: true,
    });
  }
  const diff = language === "diff";
  for (const codeLine of code) {
    const body = `  ${codeLine}`;
    if (!colour || codeLine.length === 0) {
      lines.push({ text: body, code: true });
      continue;
    }
    if (diff && codeLine.startsWith("+")) {
      lines.push({ text: styled(body, ANSI.green), code: true });
    } else if (diff && codeLine.startsWith("-")) {
      lines.push({ text: styled(body, ANSI.red), code: true });
    } else if (diff && codeLine.startsWith("@@")) {
      lines.push({ text: styled(body, ANSI.cyan), code: true });
    } else {
      lines.push({ text: styled(body, ANSI.dim), code: true });
    }
  }
  return lines;
}

/**
 * Renders one Markdown document as lines; `code` tells a client which lines
 * came from a fence, so it may draw them as monospace.
 */
export function renderMarkdownLines(
  markdown: string,
  options: RenderOptions = {},
): MarkdownLine[] {
  const colour = options.colour === true;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: MarkdownLine[] = [];
  const push = (text: string): void => {
    output.push({ text, code: false });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const opening = openingFence(line);
    if (opening !== undefined) {
      const language = opening.language;
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !closesFence(lines[index] ?? "", opening)) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      output.push(...renderCode(language, code, colour));
      continue;
    }

    const next = lines[index + 1] ?? "";
    if (line.includes("|") && isTableSeparator(next)) {
      const table: string[] = [line, next];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        table.push(lines[index] ?? "");
        index += 1;
      }
      index -= 1;
      renderTable(table, colour).forEach(push);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const raw = heading[2] ?? "";
      const title = renderInline(level === 1 ? raw.toUpperCase() : raw, colour);
      push(colour ? styled(title, ANSI.bold) : title);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line)) {
      const rule = "─".repeat(40);
      push(colour ? styled(rule, ANSI.dim) : rule);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const marker = colour ? styled("•", ANSI.cyan) : "•";
      push(`${bullet[1] ?? ""}${marker} ${renderInline(bullet[2] ?? "", colour)}`);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      const marker = `${numbered[2] ?? "1"}.`;
      push(
        `${numbered[1] ?? ""}${colour ? styled(marker, ANSI.cyan) : marker} ${renderInline(numbered[3] ?? "", colour)}`,
      );
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const marker = colour ? styled("│", ANSI.dim) : "│";
      push(`  ${marker} ${renderInline(quote[1] ?? "", colour)}`);
      continue;
    }

    push(renderInline(line, colour));
  }

  return output;
}

/** Renders one Markdown document as terminal text. */
export function renderMarkdown(
  markdown: string,
  options: RenderOptions = {},
): string {
  const output = renderMarkdownLines(markdown, options).map((line) => line.text);
  return `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
