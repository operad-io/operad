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

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function fenceLanguage(line: string): string {
  const match = /^\s*```\s*([^\s`]*)/.exec(line);
  return match?.[1] ?? "";
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
): string[] {
  const lines: string[] = [];
  if (language.length > 0) {
    lines.push(colour ? styled(`  ${language}`, ANSI.dim) : `  ${language}`);
  }
  const diff = language === "diff";
  for (const codeLine of code) {
    const body = `  ${codeLine}`;
    if (!colour || codeLine.length === 0) {
      lines.push(body);
      continue;
    }
    if (diff && (codeLine.startsWith("+++") || codeLine.startsWith("---"))) {
      lines.push(styled(body, ANSI.bold));
    } else if (diff && codeLine.startsWith("+")) {
      lines.push(styled(body, ANSI.green));
    } else if (diff && codeLine.startsWith("-")) {
      lines.push(styled(body, ANSI.red));
    } else if (diff && codeLine.startsWith("@@")) {
      lines.push(styled(body, ANSI.cyan));
    } else {
      lines.push(styled(body, ANSI.dim));
    }
  }
  return lines;
}

/** Renders one Markdown document as terminal text. */
export function renderMarkdown(
  markdown: string,
  options: RenderOptions = {},
): string {
  const colour = options.colour === true;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (isFence(line)) {
      const language = fenceLanguage(line);
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !isFence(lines[index] ?? "")) {
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
      output.push(...renderTable(table, colour));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const raw = heading[2] ?? "";
      const title = renderInline(level === 1 ? raw.toUpperCase() : raw, colour);
      output.push(colour ? styled(title, ANSI.bold) : title);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line)) {
      const rule = "─".repeat(40);
      output.push(colour ? styled(rule, ANSI.dim) : rule);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const marker = colour ? styled("•", ANSI.cyan) : "•";
      output.push(`${bullet[1] ?? ""}${marker} ${renderInline(bullet[2] ?? "", colour)}`);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      const marker = `${numbered[2] ?? "1"}.`;
      output.push(
        `${numbered[1] ?? ""}${colour ? styled(marker, ANSI.cyan) : marker} ${renderInline(numbered[3] ?? "", colour)}`,
      );
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const marker = colour ? styled("│", ANSI.dim) : "│";
      output.push(`  ${marker} ${renderInline(quote[1] ?? "", colour)}`);
      continue;
    }

    output.push(renderInline(line, colour));
  }

  return `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
