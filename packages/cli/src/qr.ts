/**
 * A QR code encoder for one job: a short link in byte mode, error correction M,
 * versions 1 to 10 (up to 213 bytes). It has no dependency. The layout follows
 * ISO/IEC 18004: finder, timing and alignment patterns, format and version
 * information, the data and its Reed-Solomon codewords interleaved over the
 * blocks, and the mask with the lowest penalty.
 */

/** A square of modules; `true` is a dark module. */
export type QrMatrix = readonly (readonly boolean[])[];

/** The text does not fit in version 10 at error correction M. */
export class QrTooLongError extends Error {
  constructor(bytes: number) {
    super(`the link is ${bytes} bytes; a QR code here holds at most ${MAX_BYTES}`);
    this.name = "QrTooLongError";
  }
}

/** Per version at level M: the check codewords per block and the blocks as [count, data codewords]. */
const BLOCKS_M: readonly {
  readonly ec: number;
  readonly groups: readonly (readonly [number, number])[];
}[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

/** The centres of the alignment patterns, per version. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MAX_VERSION = BLOCKS_M.length;

function dataCodewords(version: number): number {
  const blocks = BLOCKS_M[version - 1];
  if (blocks === undefined) throw new RangeError(`no version ${version}`);
  return blocks.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** The most bytes a version 10 code holds in byte mode at level M. */
const MAX_BYTES = Math.floor((dataCodewords(MAX_VERSION) * 8 - 4 - 16) / 8);

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let power = 0; power < 255; power += 1) {
    EXP[power] = value;
    LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power += 1) {
    EXP[power] = EXP[power - 255] ?? 0;
  }
}

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[(LOG[left] ?? 0) + (LOG[right] ?? 0)] ?? 0;
}

function generator(degree: number): number[] {
  let poly = [1];
  for (let root = 0; root < degree; root += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let index = 0; index < poly.length; index += 1) {
      const coefficient = poly[index] ?? 0;
      next[index] = (next[index] ?? 0) ^ coefficient;
      next[index + 1] = (next[index + 1] ?? 0) ^ gfMultiply(coefficient, EXP[root] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** The `degree` Reed-Solomon check codewords of `data`. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const poly = generator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] = (remainder[index] ?? 0) ^ gfMultiply(poly[index + 1] ?? 0, factor);
    }
  }
  return remainder;
}

/** The 15 format bits for level M and a mask, after the BCH code and the XOR mask. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M is 00
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up): the version and its BCH check. */
export function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

/** The codewords of the whole message, data and checks interleaved. */
function codewordsFor(bytes: Uint8Array, version: number): number[] {
  const blocks = BLOCKS_M[version - 1];
  if (blocks === undefined) throw new RangeError(`no version ${version}`);
  const capacity = dataCodewords(version);

  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    data.push(byte);
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const dataBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of blocks.groups) {
    for (let i = 0; i < count; i += 1) {
      dataBlocks.push(data.slice(offset, offset + size));
      offset += size;
    }
  }
  const checkBlocks = dataBlocks.map((block) => reedSolomon(block, blocks.ec));

  const result: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) {
      const value = block[i];
      if (value !== undefined) result.push(value);
    }
  }
  for (let i = 0; i < blocks.ec; i += 1) {
    for (const block of checkBlocks) result.push(block[i] ?? 0);
  }
  return result;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const mark = this.reserved[y];
    if (row === undefined || mark === undefined || x < 0 || x >= this.size) return;
    row[x] = dark;
    mark[x] = true;
  }

  get(x: number, y: number): boolean {
    return this.modules[y]?.[x] ?? false;
  }

  finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(size - 4, 3);
    this.finder(3, size - 4);
    const centres = ALIGNMENT[this.version - 1] ?? [];
    const last = centres.length - 1;
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = 0; j < centres.length; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.alignment(centres[i] ?? 0, centres[j] ?? 0);
      }
    }
    this.drawFormat(0);
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i += 1) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }

  drawFormat(mask: number): void {
    const size = this.size;
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i += 1) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i += 1) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true);
  }

  drawCodewords(codewords: readonly number[]): void {
    const size = this.size;
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (this.reserved[y]?.[x] === true) continue;
          const word = codewords[index >>> 3];
          const dark = word !== undefined && bit(word, 7 - (index & 7));
          const row = this.modules[y];
          if (row !== undefined) row[x] = dark;
          index += 1;
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.reserved[y]?.[x] === true) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        const row = this.modules[y];
        if (invert && row !== undefined) row[x] = !row[x];
      }
    }
  }

  penalty(): number {
    const size = this.size;
    let total = 0;
    const lines: boolean[][] = [];
    for (let y = 0; y < size; y += 1) lines.push(this.modules[y] ?? []);
    for (let x = 0; x < size; x += 1) {
      lines.push(Array.from({ length: size }, (_, y) => this.get(x, y)));
    }
    // Rules 1 and 3 on every row and column.
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i += 1) {
        if (i < size && line[i] === line[i - 1]) {
          run += 1;
        } else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
        }
      }
      const text = line.map((dark) => (dark ? "1" : "0")).join("");
      for (const pattern of ["10111010000", "00001011101"]) {
        let at = text.indexOf(pattern);
        while (at >= 0) {
          total += 40;
          at = text.indexOf(pattern, at + 1);
        }
      }
    }
    // Rule 2: 2 by 2 blocks of one colour.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const colour = this.get(x, y);
        if (colour === this.get(x + 1, y) && colour === this.get(x, y + 1) && colour === this.get(x + 1, y + 1)) {
          total += 3;
        }
      }
    }
    // Rule 4: the share of dark modules.
    let dark = 0;
    for (const row of this.modules) for (const module of row) if (module) dark += 1;
    const cells = size * size;
    total += (Math.ceil(Math.abs(dark * 20 - cells * 10) / cells) - 1) * 10;
    return total;
  }
}

/** Encodes `text` as UTF-8 bytes in a QR code at level M, the smallest version that fits. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (
    version <= MAX_VERSION &&
    4 + countBits(version) + bytes.length * 8 > dataCodewords(version) * 8
  ) {
    version += 1;
  }
  if (version > MAX_VERSION) throw new QrTooLongError(bytes.length);

  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(codewordsFor(bytes, version));

  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    grid.applyMask(mask);
    grid.drawFormat(mask);
    const score = grid.penalty();
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    grid.applyMask(mask);
  }
  grid.applyMask(best);
  grid.drawFormat(best);
  return grid.modules.map((row) => [...row]);
}

/**
 * The matrix as terminal text: two module rows per line in half blocks, black
 * on white with a quiet zone of four modules, so a phone reads it on a dark
 * terminal too.
 */
export function renderQr(matrix: QrMatrix, quiet = 4): string {
  const size = matrix.length;
  const at = (x: number, y: number): boolean => matrix[y - quiet]?.[x - quiet] === true;
  const total = size + quiet * 2;
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = "";
    for (let x = 0; x < total; x += 1) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`\u001b[30;47m${line}\u001b[0m`);
  }
  return `${lines.join("\n")}\n`;
}
