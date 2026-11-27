/**
 * Where output may be cut. A screen is serialized between two pieces of output,
 * and the serialized form does not carry half an escape sequence, so a piece
 * ends only after a whole one.
 */

const ESC = "\u001b";
const BEL = "\u0007";
const CAN = "\u0018";
const SUB = "\u001a";

/** The longest unfinished sequence that is held back; a longer one is passed on. */
export const MAX_HELD_CHARACTERS = 64 * 1024;

/** The index after the sequence that starts at `start`, or undefined while it is unfinished. */
function sequenceEnd(text: string, start: number): number | undefined {
  const kind = text[start + 1];
  if (kind === undefined) return undefined;
  // A second ESC starts over.
  if (kind === ESC) return start + 1;
  const isString = kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_";
  if (isString) {
    for (let at = start + 2; at < text.length; at += 1) {
      const char = text[at];
      if (char === CAN || char === SUB || (char === BEL && kind === "]")) return at + 1;
      if (char !== ESC) continue;
      if (text[at + 1] === undefined) return undefined;
      // `ESC \` ends the string; any other ESC ends it and starts a sequence.
      return text[at + 1] === "\\" ? at + 2 : at;
    }
    return undefined;
  }
  const isControl = kind === "[";
  if (!isControl && (kind < " " || kind > "/")) return start + 2;
  // A control sequence ends at 0x40 to 0x7e; one with intermediates at 0x30 to 0x7e.
  const first = isControl ? "@" : "0";
  for (let at = start + 2; at < text.length; at += 1) {
    const char = text[at] ?? "";
    if (char === ESC) return at;
    if (char === CAN || char === SUB || (char >= first && char <= "~")) return at + 1;
  }
  return undefined;
}

/** Splits text before an unfinished escape sequence at its end. */
export function splitUnfinished(text: string): readonly [whole: string, held: string] {
  let at = text.indexOf(ESC);
  while (at >= 0) {
    const end = sequenceEnd(text, at);
    if (end === undefined) {
      if (text.length - at > MAX_HELD_CHARACTERS) break;
      return [text.slice(0, at), text.slice(at)];
    }
    at = text.indexOf(ESC, end);
  }
  return [text, ""];
}
