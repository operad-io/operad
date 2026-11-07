import { describe, expect, test } from "bun:test";
import {
  QrTooLongError,
  encodeQr,
  formatBits,
  reedSolomon,
  renderQr,
  versionBits,
} from "../src/qr.ts";
import { CAPACITY_BYTES, FORMAT_M, decode, matrixFromRender } from "./qr-decode.ts";

describe("qr encoder", () => {
  test("the check codewords match a known vector", () => {
    // "HELLO WORLD" at version 1, level M (the worked example in the standard's tutorials).
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test("the format bits for level M match the standard's table", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits)).toEqual(FORMAT_M);
  });

  test("the version bits match the standard's table", () => {
    expect([7, 8, 9, 10].map(versionBits)).toEqual([0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
  });

  test("a pairing link decodes to itself", () => {
    const link = `operad://pair?url=${encodeURIComponent("http://192.168.1.20:7480")}&token=${"A".repeat(43)}`;
    const matrix = encodeQr(link);
    const decoded = decode(matrix);
    expect(decoded.text).toBe(link);
  });

  test("every version round-trips at its capacity, and the next byte needs the next version", () => {
    CAPACITY_BYTES.forEach((capacity, index) => {
      const full = "x".repeat(capacity);
      const decoded = decode(encodeQr(full));
      expect(decoded.version).toBe(index + 1);
      expect(decoded.text).toBe(full);
      if (index + 1 < CAPACITY_BYTES.length) {
        const over = decode(encodeQr(`${full}y`));
        expect(over.version).toBe(index + 2);
        expect(over.text).toBe(`${full}y`);
      }
    });
  });

  test("a varied payload and UTF-8 round-trip", () => {
    for (const text of ["", "a", "操作 — operad://objects/task%3AT-1", "~!@#$%^&*()_+{}|:\"<>?".repeat(5)]) {
      expect(decode(encodeQr(text)).text).toBe(text);
    }
  });

  test("a text of more than 213 bytes is refused", () => {
    expect(() => encodeQr("x".repeat(214))).toThrow(QrTooLongError);
  });

  test("the encoder is deterministic", () => {
    expect(encodeQr("operad://pair")).toEqual(encodeQr("operad://pair"));
  });

  test("the rendering reads back to the matrix", () => {
    const matrix = encodeQr("operad://pair?x=1");
    expect(matrixFromRender(renderQr(matrix))).toEqual(matrix);
  });

  test("the rendering has a quiet zone and two module rows per line", () => {
    const matrix = encodeQr("hi");
    const lines = renderQr(matrix).trimEnd().split("\n");
    expect(lines).toHaveLength(Math.ceil((matrix.length + 8) / 2));
    // eslint-disable-next-line no-control-regex
    const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(plain[0]).toBe(" ".repeat(matrix.length + 8));
    expect(plain.every((line) => [...line].length === matrix.length + 8)).toBe(true);
  });
});
