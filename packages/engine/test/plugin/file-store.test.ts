import { afterAll, describe, expect, test } from "bun:test";
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
    expect(reader.list("job").length).toBe(1);
    expect(reader.facts().length).toBe(2);
  });
});
