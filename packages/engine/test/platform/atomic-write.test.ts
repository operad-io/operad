import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from "../../src/platform/index.ts";

const root = mkdtempSync(join(tmpdir(), "operad-atomic-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("atomic writes", () => {
  test("writes a missing directory and keeps the mode of a file that exists", async () => {
    const file = join(root, "nested", "a.txt");
    await writeFileAtomic(file, "first");
    expect(readFileSync(file, "utf8")).toBe("first");
    chmodSync(file, 0o600);
    await writeFileAtomic(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a named mode applies to a new file", async () => {
    const file = join(root, "secret.json");
    await writeJsonAtomic(file, { a: 1 }, { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("the synchronous form writes JSON in the asked shape and leaves no temporary file", () => {
    const file = join(root, "b.json");
    writeJsonAtomicSync(file, { a: 1 });
    expect(readFileSync(file, "utf8")).toBe('{"a":1}\n');
    writeJsonAtomicSync(file, { a: 1 }, { space: 2, newline: false });
    expect(readFileSync(file, "utf8")).toBe('{\n  "a": 1\n}');
    writeFileAtomicSync(file, "x");
    expect(readFileSync(file, "utf8")).toBe("x");
    expect(readdirSync(dirname(file)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("a write refused before the rename leaves the old file and no temporary file", async () => {
    const file = join(root, "c.txt");
    writeFileSync(file, "old");
    await expect(
      writeFileAtomic(file, "new", {
        beforeRename: () => {
          throw new Error("stop");
        },
      }),
    ).rejects.toThrow("stop");
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(readdirSync(dirname(file)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
