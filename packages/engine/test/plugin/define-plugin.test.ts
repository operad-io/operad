import { expect, test } from "bun:test";
import { definePlugin } from "../../src/index.ts";

test("definePlugin adds the plugin API version", () => {
  const plugin = definePlugin({
    name: "notes",
    kind: "domain",
    version: "1.0.0",
    objects: [{ name: "note" }],
  });
  expect(plugin.operadPlugin).toBe(1);
  expect(plugin.name).toBe("notes");
  expect(plugin.kind).toBe("domain");
  expect(plugin.objects).toEqual([{ name: "note" }]);
});
