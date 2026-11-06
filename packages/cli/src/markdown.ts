/**
 * A small terminal renderer for the one content type the kernel has: Markdown
 * with GFM tables and fenced code. It draws no plugin colours; headings,
 * emphasis and links become plain readable text.
 */

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

function renderTable(rows: readonly string[]): string[] {
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
      const text = stripInline(row[index] ?? "");
      const length = visibleLength(text);
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
  lines.push(
    `|${widths.map((size) => "-".repeat(size + 2)).join("|")}|`,
  );
  for (const row of cells.slice(1)) {
    if (isTableSeparator(row.join("|"))) continue;
    lines.push(draw(row, "|"));
  }
  return lines;
}

/** Renders one Markdown document as plain terminal text. */
export function renderMarkdown(markdown: string): string {
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
      if (language.length > 0) {
        output.push(`  ${language}`);
      }
      for (const codeLine of code) {
        output.push(`  ${codeLine}`);
      }
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
      output.push(...renderTable(table));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const title = stripInline(heading[2] ?? "");
      output.push(level === 1 ? title.toUpperCase() : title);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line)) {
      output.push("─".repeat(40));
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      output.push(`${bullet[1] ?? ""}• ${stripInline(bullet[2] ?? "")}`);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      output.push(
        `${numbered[1] ?? ""}${numbered[2] ?? "1"}. ${stripInline(numbered[3] ?? "")}`,
      );
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      output.push(`  │ ${stripInline(quote[1] ?? "")}`);
      continue;
    }

    output.push(stripInline(line));
  }

  return `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
