/**
 * Wrapping for rendered Markdown. The reducer counts the rows a section takes
 * and the view draws exactly those rows, so both use this one algorithm, and
 * both measure by display width: a CJK character or an emoji takes two columns,
 * a combining mark none.
 */

/** One display character (a grapheme) and the style it carries. */
export interface WrapGlyph<T> {
  readonly char: string;
  readonly value: T;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PLAIN = /^[\x20-\x7e]*$/;

/** The display characters of `text`: grapheme clusters, not code points. */
export function graphemes(text: string): string[] {
  if (PLAIN.test(text)) return [...text];
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** The columns one display character takes: 0, 1 or 2. */
export function displayWidth(char: string): number {
  if (char.length === 1) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) return 1;
  }
  return Bun.stringWidth(char);
}

/** The columns a whole string takes. */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of graphemes(text)) width += displayWidth(char);
  return width;
}

function isSpace(char: string): boolean {
  return /^\s/u.test(char);
}

function tokensOf<T>(glyphs: readonly WrapGlyph<T>[]): WrapGlyph<T>[][] {
  const tokens: WrapGlyph<T>[][] = [];
  let current: WrapGlyph<T>[] = [];
  let currentSpace: boolean | undefined;
  for (const glyph of glyphs) {
    const space = isSpace(glyph.char);
    if (current.length > 0 && space !== currentSpace) {
      tokens.push(current);
      current = [];
    }
    current.push(glyph);
    currentSpace = space;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function widthOf<T>(glyphs: readonly WrapGlyph<T>[]): number {
  let width = 0;
  for (const glyph of glyphs) width += displayWidth(glyph.char);
  return width;
}

/** Cuts a word wider than a row into rows of at most `limit` columns. */
function cut<T>(
  token: readonly WrapGlyph<T>[],
  limit: number,
): { readonly full: WrapGlyph<T>[][]; readonly rest: WrapGlyph<T>[]; readonly used: number } {
  const full: WrapGlyph<T>[][] = [];
  let row: WrapGlyph<T>[] = [];
  let used = 0;
  for (const glyph of token) {
    const width = displayWidth(glyph.char);
    // A glyph wider than the whole row still goes on a row of its own.
    if (used > 0 && used + width > limit) {
      full.push(row);
      row = [];
      used = 0;
    }
    row.push(glyph);
    used += width;
  }
  return { full, rest: row, used };
}

/**
 * Breaks glyphs into the rows a terminal of `width` columns shows. A word moves
 * whole to the next row when it fits there; one wider than a row is hard-cut.
 */
export function wrapGlyphs<T>(
  glyphs: readonly WrapGlyph<T>[],
  width: number,
): WrapGlyph<T>[][] {
  const limit = Math.max(1, Math.trunc(width));
  if (glyphs.length === 0) return [[]];

  const lines: WrapGlyph<T>[][] = [];
  let line: WrapGlyph<T>[] = [];
  let used = 0;
  const push = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const token of tokensOf(glyphs)) {
    if (isSpace(token[0]?.char ?? "")) {
      for (const glyph of token) {
        const size = displayWidth(glyph.char);
        if (used + size > limit) {
          if (line.some((current) => !isSpace(current.char))) push();
        } else {
          line.push(glyph);
          used += size;
        }
      }
      continue;
    }

    const size = widthOf(token);
    if (used + size <= limit) {
      line.push(...token);
      used += size;
      continue;
    }

    if (line.some((current) => !isSpace(current.char))) {
      while (line.length > 0 && isSpace(line[line.length - 1]?.char ?? "")) {
        const last = line.pop();
        used -= displayWidth(last?.char ?? "");
      }
      push();
    } else {
      line = [];
      used = 0;
    }

    const pieces = cut(token, limit);
    lines.push(...pieces.full);
    line = pieces.rest;
    used = pieces.used;
  }

  lines.push(line);
  return lines;
}

/** The same wrapping for plain text, where only the row count and text matter. */
export function wrapText(text: string, width: number): string[] {
  return wrapGlyphs(
    graphemes(text).map((char) => ({ char, value: undefined })),
    width,
  ).map((line) => line.map((glyph) => glyph.char).join(""));
}
