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
  weak: "\x1b[90m",
} as const;

export interface RenderOptions {
  /** Add ANSI styling, for a terminal; off by default. */
  readonly colour?: boolean | undefined;
  /**
   * Terminal columns available. With it a table is laid out to fit: one line
   * per row, no pipes. Without it a table keeps its natural width.
   */
  readonly width?: number | undefined;
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
    .replace(CODE_SPAN, (_match, _fence: string, body: string) => unpadCode(body))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_]+)_/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1");
}

/** A CommonMark code span: a run of backticks, a body, the same run again. */
const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

/** CommonMark: a body with a space at both ends and something else inside loses one space each side. */
function unpadCode(body: string): string {
  return body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim().length > 0 ? body.slice(1, -1) : body;
}

/** Styles inline text without changing what a terminal shows. */
function styledInline(text: string): string {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    out += styledPlainInline(text.slice(at, match.index));
    out += styled(unpadCode(match[2] ?? ""), ANSI.cyan);
    at = match.index + match[0].length;
  }
  return out + styledPlainInline(text.slice(at));
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

const NUMERIC_CELL =
  /^[-+~≈]?[$€£¥]?\s?\d[\d,]*(\.\d+)?\s?(%|ms|s|m|h|d|w|[kKMB])?(\s\d+(\.\d+)?\s?(ms|s|m|h|d))*$/;

/** True for a number, a duration or an amount of money. */
function isNumericCell(text: string): boolean {
  return NUMERIC_CELL.test(stripInline(text).trim());
}

/** The widest columns shrink first, down to `floor`, until `excess` is gone. */
function shrinkWidest(
  widths: number[],
  eligible: readonly boolean[],
  floor: number,
  excess: number,
): number {
  let left = excess;
  while (left > 0) {
    let pick = -1;
    for (let index = 0; index < widths.length; index += 1) {
      const size = widths[index] ?? 0;
      if (eligible[index] !== true || size <= floor) continue;
      if (pick < 0 || size > (widths[pick] ?? 0)) pick = index;
    }
    if (pick < 0) break;
    widths[pick] = (widths[pick] ?? 0) - 1;
    left -= 1;
  }
  return left;
}

/** Terminal columns a text takes: CJK and emoji are two wide. */
function displayWidth(text: string): number {
  return Bun.stringWidth(stripInline(text));
}

const SEGMENTER = new Intl.Segmenter();

function cut(text: string, size: number): string {
  const plain = stripInline(text);
  if (Bun.stringWidth(plain) <= size) return plain;
  let kept = "";
  let used = 0;
  for (const { segment } of SEGMENTER.segment(plain)) {
    const next = Bun.stringWidth(segment);
    if (used + next > size - 1) break;
    kept += segment;
    used += next;
  }
  return `${kept}…`;
}

/** A table laid out for `available` columns: no pipes, one line per row. */
function renderFittedTable(
  rows: readonly string[],
  colour: boolean,
  available: number,
): string[] {
  const cells = rows
    .map(splitCells)
    .filter((row, index) => index === 0 || !isTableSeparator(row.join("|")));
  const count = Math.max(1, ...cells.map((row) => row.length));
  const widths: number[] = [];
  const numeric: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    widths.push(
      Math.max(1, ...cells.map((row) => displayWidth(row[index] ?? ""))),
    );
    const body = cells
      .slice(1)
      .map((row) => row[index] ?? "")
      .filter((cell) => cell.length > 0);
    numeric.push(body.length > 0 && body.every(isNumericCell));
  }
  const gap = 2;
  const total = (): number =>
    widths.reduce((sum, size) => sum + size, 0) + gap * (count - 1);
  const text = numeric.map((flag) => !flag);
  const all = numeric.map(() => true);
  // Long text columns first, keeping short ones whole; only then anything.
  for (const [eligible, floor] of [
    [text, 12],
    [text, 4],
    [all, 3],
    [all, 1],
  ] as const) {
    const excess = total() - available;
    if (excess <= 0) break;
    shrinkWidest(widths, eligible, floor, excess);
  }

  const draw = (row: readonly string[], header: boolean): string => {
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const cell = row[index] ?? "";
      const size = widths[index] ?? 1;
      const length = displayWidth(cell);
      const fits = length <= size;
      const shown = fits ? cell : cut(cell, size);
      const body = header
        ? stripInline(shown)
        : fits
          ? renderInline(shown, colour)
          : shown;
      const pad = " ".repeat(Math.max(0, size - (fits ? length : Bun.stringWidth(shown))));
      const styledBody =
        header && colour ? styled(body, `${ANSI.bold}${ANSI.weak}`) : body;
      parts.push(numeric[index] === true ? `${pad}${styledBody}` : `${styledBody}${pad}`);
    }
    return parts.join(" ".repeat(gap)).replace(/\s+$/, "");
  };

  const lines = [draw(cells[0] ?? [], true)];
  const rule = "─".repeat(Math.max(1, Math.min(total(), available)));
  lines.push(colour ? styled(rule, ANSI.weak) : rule);
  for (const row of cells.slice(1)) lines.push(draw(row, false));
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
  const width =
    options.width !== undefined && Number.isFinite(options.width) && options.width > 0
      ? Math.floor(options.width)
      : undefined;
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
      (width === undefined
        ? renderTable(table, colour)
        : renderFittedTable(table, colour, width)
      ).forEach(push);
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
