import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SqlitePluginStore } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

describe("listing objects of a large type", () => {
  test("an object that did not change is not read or parsed again", async () => {
    const root = await tempRoot();
    const store = new SqlitePluginStore({ root: join(root, "plugins"), follow: false });
    for (let index = 0; index < 500; index += 1) {
      store.put("task", `t-${String(index).padStart(4, "0")}`, { n: index }, "test");
    }

    const first = store.list("task", { limit: 1000 });
    const second = store.list("task", { limit: 1000 });
    expect(second.objects).toHaveLength(500);
    // The same remembered copies come back: nothing was read from the data.
    expect(second.objects.every((object, i) => object === first.objects[i])).toBe(true);

    store.put("task", "t-0007", { n: -7 }, "test");
    const third = store.list("task", { limit: 1000 });
    const changed = third.objects.filter((object, i) => object !== first.objects[i]);
    expect(changed.map((object) => object.id)).toEqual(["t-0007"]);
    expect(changed[0]?.data).toEqual({ n: -7 });
  });

  test("a page stops at its limit instead of reading the rest of the type", async () => {
    const root = await tempRoot();
    const store = new SqlitePluginStore({ root: join(root, "plugins"), follow: false });
    for (let index = 0; index < 50; index += 1) {
      store.put("task", `t-${String(index).padStart(3, "0")}`, { n: index }, "test");
    }
    const page = store.list("task", { limit: 5 });
    expect(page.objects.map((object) => object.id)).toEqual([
      "t-000", "t-001", "t-002", "t-003", "t-004",
    ]);
    const next = store.list("task", { limit: 5, ...(page.next === undefined ? {} : { cursor: page.next }) });
    expect(next.objects[0]?.id).toBe("t-005");
  });
});
