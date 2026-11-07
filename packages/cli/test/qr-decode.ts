import { expect } from "bun:test";
import type { QrMatrix } from "../src/qr.ts";

// The decoder below is written from the standard, apart from the encoder: it
// shares no code with it except the matrix it reads.

export const FORMAT_M = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
  0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
];
const RAW_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_PER_VERSION = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const CAPACITY_BYTES = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

const EXP: number[] = [];
const LOG: number[] = new Array<number>(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = x * 2 > 255 ? (x * 2) ^ 0x11d : x * 2;
  }
}
const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0);

function dark(matrix: QrMatrix, x: number, y: number): boolean {
  return matrix[y]?.[x] === true;
}

function isFunction(version: number, size: number, x: number, y: number): boolean {
  if (x <= 8 && y <= 8) return true;
  if (x >= size - 8 && y <= 8) return true;
  if (x <= 8 && y >= size - 8) return true;
  if (x === 6 || y === 6) return true;
  if (version >= 7) {
    if (x >= size - 11 && x <= size - 9 && y <= 5) return true;
    if (y >= size - 11 && y <= size - 9 && x <= 5) return true;
  }
  const centres = ALIGN[version - 1] ?? [];
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      if (Math.abs(x - (centres[i] ?? 0)) <= 2 && Math.abs(y - (centres[j] ?? 0)) <= 2) return true;
    }
  }
  return false;
}

function maskFlips(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Reads a matrix back to its text, failing on any inconsistency. */
export function decode(matrix: QrMatrix): { readonly version: number; readonly text: string } {
  const size = matrix.length;
  const version = (size - 17) / 4;
  expect(Number.isInteger(version) && version >= 1 && version <= 10).toBe(true);

  // Finder patterns, timing and the dark module.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        expect(dark(matrix, cx + dx, cy + dy)).toBe(ring !== 2);
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    expect(dark(matrix, i, 6)).toBe(i % 2 === 0);
    expect(dark(matrix, 6, i)).toBe(i % 2 === 0);
  }
  expect(dark(matrix, 8, size - 8)).toBe(true);

  // Both copies of the format bits agree and name level M.
  let first = 0;
  const firstCopy: [number, number][] = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  firstCopy.forEach(([x, y], i) => {
    if (dark(matrix, x, y)) first |= 1 << (14 - i);
  });
  let second = 0;
  for (let i = 0; i < 7; i += 1) if (dark(matrix, 8, size - 1 - i)) second |= 1 << (14 - i);
  for (let i = 7; i < 15; i += 1) if (dark(matrix, size - 15 + i, 8)) second |= 1 << (14 - i);
  expect(second).toBe(first);
  const mask = FORMAT_M.indexOf(first);
  expect(mask).toBeGreaterThanOrEqual(0);

  // Version information.
  if (version >= 7) {
    let read = 0;
    for (let i = 0; i < 18; i += 1) {
      if (dark(matrix, size - 11 + (i % 3), Math.floor(i / 3))) read |= 1 << i;
    }
    expect(read >> 12).toBe(version);
  }

  // The codewords, read in the zigzag the standard describes.
  const bits: number[] = [];
  let upward = true;
  for (let x = size - 1; x >= 0; x -= 2) {
    if (x === 6) x -= 1;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const column of [x, x - 1]) {
        if (isFunction(version, size, column, y)) continue;
        bits.push(Number(dark(matrix, column, y) !== maskFlips(mask, column, y)));
      }
    }
    upward = !upward;
  }
  const raw = RAW_CODEWORDS[version - 1] ?? 0;
  const words: number[] = [];
  for (let i = 0; i < raw; i += 1) {
    let word = 0;
    for (let j = 0; j < 8; j += 1) word = (word << 1) | (bits[i * 8 + j] ?? 0);
    words.push(word);
  }
  // What is left over is remainder bits, all light.
  expect(bits.slice(raw * 8).every((value) => value === 0)).toBe(true);

  // Undo the interleave: data columns across blocks, then the check columns.
  const blocks = BLOCKS_PER_VERSION[version - 1] ?? 1;
  const ec = EC_PER_BLOCK[version - 1] ?? 0;
  const dataTotal = raw - blocks * ec;
  const short = Math.floor(dataTotal / blocks);
  const longBlocks = dataTotal % blocks;
  const sizes = Array.from({ length: blocks }, (_, i) => short + (i >= blocks - longBlocks ? 1 : 0));
  const dataOf: number[][] = sizes.map(() => []);
  let at = 0;
  for (let column = 0; column < short + 1; column += 1) {
    sizes.forEach((length, block) => {
      if (column < length) dataOf[block]?.push(words[at++] ?? 0);
    });
  }
  const checkOf: number[][] = sizes.map(() => []);
  for (let column = 0; column < ec; column += 1) {
    sizes.forEach((_, block) => checkOf[block]?.push(words[at++] ?? 0));
  }
  expect(at).toBe(raw);

  // Every block is a Reed-Solomon codeword: its syndromes are zero.
  sizes.forEach((_, block) => {
    const codeword = [...(dataOf[block] ?? []), ...(checkOf[block] ?? [])];
    for (let root = 0; root < ec; root += 1) {
      let sum = 0;
      for (const symbol of codeword) sum = mul(sum, EXP[root] ?? 0) ^ symbol;
      expect(sum).toBe(0);
    }
  });

  // Byte mode, the length, the bytes.
  const data = dataOf.flat();
  const stream = data.flatMap((word) => Array.from({ length: 8 }, (_, i) => (word >> (7 - i)) & 1));
  const take = (from: number, count: number): number =>
    stream.slice(from, from + count).reduce((value, b) => (value << 1) | b, 0);
  expect(take(0, 4)).toBe(0b0100);
  const countLength = version < 10 ? 8 : 16;
  const length = take(4, countLength);
  const bytes = Uint8Array.from({ length }, (_, i) => take(4 + countLength + i * 8, 8));
  return { version, text: new TextDecoder().decode(bytes) };
}


/** Reads the terminal rendering back into a matrix: half blocks, four modules of quiet zone. */
export function matrixFromRender(text: string, quiet = 4): QrMatrix {
  // eslint-disable-next-line no-control-regex
  const lines = text.split("\n").filter((line) => line.includes("\u001b[30;47m")).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  const width = [...(lines[0] ?? "")].length;
  const rows: boolean[][] = [];
  for (const line of lines) {
    const cells = [...line];
    rows.push(cells.map((c) => c === "█" || c === "▀"));
    rows.push(cells.map((c) => c === "█" || c === "▄"));
  }
  const size = width - quiet * 2;
  return rows.slice(quiet, quiet + size).map((row) => row.slice(quiet, quiet + size));
}
