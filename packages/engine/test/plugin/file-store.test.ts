import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FilePluginStore } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

describe("the file plugin store", () => {
  test("a second reader sees facts another writer appended", async () => {
    const root = await tempRoot();
    const directory = join(root, "plugins");
    const writer = new FilePluginStore({ root: directory });
    const reader = new FilePluginStore({ root: directory });

    writer.put("job", "1", { title: "one" }, "seed");
    expect(reader.get("job", "1")?.data).toEqual({ title: "one" });

    writer.put("job", "1", { title: "two" }, "edit");
    const object = reader.get("job", "1");
    expect(object?.data).toEqual({ title: "two" });
    expect(object?.version).toBe(2);
    expect(reader.list("job").objects.length).toBe(1);
    expect(reader.facts().length).toBe(2);
  });

  test("refresh reads only past its offset, and a torn multi-byte line waits for its newline", async () => {
    const root = await tempRoot();
    const directory = join(root, "plugins");
    const factsPath = join(directory, "facts.jsonl");
    const writer = new FilePluginStore({ root: directory });
    writer.put("job", "1", { title: "café" }, "seed");

    const calls: Array<{ readonly position: number; readonly length: number }> = [];
    const reader = new FilePluginStore({
      root: directory,
      watch: () => () => undefined,
      repeat: () => () => undefined,
      readAt: (path, position, length) => {
        calls.push({ position, length });
        return readFileSync(path).subarray(position, position + length);
      },
    });
    expect(calls[0]).toEqual({ position: 0, length: statSync(factsPath).size });
    const offset = statSync(factsPath).size;
    calls.length = 0;

    const line = Buffer.from(
      `${JSON.stringify({
        sequence: 2,
        type: "job",
        object: { type: "job", id: "1" },
        cause: "edit",
        at: 2,
        data: { title: "naïve" },
      })}\n`,
      "utf8",
    );
    const inside = line.indexOf(Buffer.from("ï", "utf8")) + 1;
    expect(inside).toBeGreaterThan(1);
    appendFileSync(factsPath, line.subarray(0, inside));

    expect(reader.get("job", "1")?.data).toEqual({ title: "café" });
    expect(calls).toEqual([{ position: offset, length: inside }]);

    calls.length = 0;
    appendFileSync(factsPath, line.subarray(inside));
    expect(reader.get("job", "1")?.data).toEqual({ title: "naïve" });
    expect(calls).toEqual([{ position: offset, length: line.length }]);

    calls.length = 0;
    writer.put("job", "1", { title: "plain" }, "edit");
    expect(reader.get("job", "1")?.data).toEqual({ title: "plain" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.position).toBe(offset + line.length);
    expect(calls[0]?.length).toBe(statSync(factsPath).size - offset - line.length);
  });

  test("a subscription still reports a write the watch does not", async () => {
    const root = await tempRoot();
    const directory = join(root, "plugins");
    const writer = new FilePluginStore({ root: directory });
    let fire: (() => void) | undefined;
    const reader = new FilePluginStore({
      root: directory,
      watch: () => () => undefined,
      repeat: (_ms, callback) => {
        fire = callback;
        return () => {
          fire = undefined;
        };
      },
    });

    const seen: string[] = [];
    const stop = reader.subscribe((object) => seen.push(`${object.type}:${object.id}`));
    try {
      writer.put("job", "1", { title: "one" }, "seed");
      expect(seen).toEqual([]);

      fire?.();
      expect(seen).toEqual(["job:1"]);
    } finally {
      stop();
    }
    expect(fire).toBeUndefined();
  });
});
