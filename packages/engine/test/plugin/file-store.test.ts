import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FilePluginStore, openPluginStore } from "../../src/index.ts";
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

  test("a store opened for one-shot use sets no watch or timer on subscribe", async () => {
    const root = await tempRoot();
    let watches = 0;
    let repeats = 0;
    const store = openPluginStore({
      backend: "jsonl",
      root,
      follow: false,
      watch: () => {
        watches += 1;
        return () => undefined;
      },
      repeat: () => {
        repeats += 1;
        return () => undefined;
      },
    });
    const stop = store.subscribe(() => undefined);
    stop();
    expect(watches).toBe(0);
    expect(repeats).toBe(0);
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
