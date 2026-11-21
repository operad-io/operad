import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bareId,
  cut,
  definitionName,
  directoryError,
  errorCode,
  isMissingFile,
  objectKey,
  parseObjectId,
  parseObjectKey,
} from "../src/index.ts";

describe("typed object ids", () => {
  test("a type and id split at the first colon", () => {
    expect(parseObjectId("item:T-1")).toEqual({ type: "item", id: "T-1" });
    expect(parseObjectId("item:repo/T-1:x")).toEqual({ type: "item", id: "repo/T-1:x" });
    expect(parseObjectId("flow:clock/hourly")).toEqual({ type: "flow", id: "clock/hourly" });
  });

  test("an id without a type, or with an empty one, is not a typed id", () => {
    expect(parseObjectId("T-1")).toBeUndefined();
    expect(parseObjectId(":T-1")).toBeUndefined();
    expect(parseObjectId("item:")).toBeUndefined();
  });

  test("a caller that needs an empty id asks for it", () => {
    expect(parseObjectId("chat:", { allowEmptyId: true })).toEqual({ type: "chat", id: "" });
  });

  test("bareId strips the type, and leaves an untyped id alone", () => {
    expect(bareId("item:T-1")).toBe("T-1");
    expect(bareId("T-1")).toBe("T-1");
    expect(bareId("item:")).toBe("");
  });

  test("objectKey builds both a run's key and an object's key", () => {
    expect(objectKey(undefined)).toBe("flow");
    expect(objectKey({ type: "item", id: "T-1" })).toBe("item:T-1");
    expect(objectKey("item", "T-1")).toBe("item:T-1");
  });

  test("parseObjectKey still refuses the flow key", () => {
    expect(parseObjectKey("flow:clock/hourly")).toBeUndefined();
    expect(parseObjectKey("job:3")).toEqual({ type: "job", id: "3" });
  });
});

describe("shared small helpers", () => {
  test("definitionName reads only a declared string name", () => {
    expect(definitionName({ name: "dev" })).toBe("dev");
    expect(definitionName({ name: 3 })).toBeUndefined();
    expect(definitionName({})).toBeUndefined();
    expect(definitionName(null)).toBeUndefined();
    expect(definitionName("dev")).toBeUndefined();
  });

  test("errorCode and isMissingFile read a filesystem error's code", () => {
    expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(errorCode({ code: 2 })).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
    expect(isMissingFile({ code: "ENOENT" })).toBe(true);
    expect(isMissingFile({ code: "EEXIST" })).toBe(false);
    expect(isMissingFile(new Error("missing"))).toBe(false);
  });

  test("cut keeps short text and cuts long text with an ellipsis", () => {
    expect(cut("short", 10)).toBe("short");
    expect(cut("abcdef", 4)).toBe("abc…");
  });

  test("directoryError names a missing directory and a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "operad-util-"));
    try {
      const file = join(root, "file");
      await writeFile(file, "x");
      expect(await directoryError(root)).toBeUndefined();
      expect(await directoryError(join(root, "missing"))).toBe(`cwd does not exist: ${join(root, "missing")}`);
      expect(await directoryError(file)).toBe(`cwd is not a directory: ${file}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
