/**
 * Wrapping for rendered Markdown. The reducer counts the rows a section takes
 * and the view draws exactly those rows, so both use this one algorithm.
 */

/** One display character and the style it carries. */
export interface WrapGlyph<T> {
  readonly char: string;
  readonly value: T;
}

function isSpace(char: string): boolean {
  return /\s/u.test(char);
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
        if (used + 1 > limit) {
          if (line.some((current) => !isSpace(current.char))) push();
        } else {
          line.push(glyph);
          used += 1;
        }
      }
      continue;
    }

    if (used + token.length <= limit) {
      line.push(...token);
      used += token.length;
      continue;
    }

    if (line.some((current) => !isSpace(current.char))) {
      while (line.length > 0 && isSpace(line[line.length - 1]?.char ?? "")) {
        line.pop();
        used -= 1;
      }
      push();
    } else {
      line = [];
      used = 0;
    }

    let rest = token;
    while (rest.length > limit) {
      lines.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    line = [...rest];
    used = rest.length;
  }

  lines.push(line);
  return lines;
}

/** The same wrapping for plain text, where only the row count and text matter. */
export function wrapText(text: string, width: number): string[] {
  return wrapGlyphs(
    [...text].map((char) => ({ char, value: undefined })),
    width,
  ).map((line) => line.map((glyph) => glyph.char).join(""));
}
