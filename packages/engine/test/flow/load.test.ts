import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadFlow } from "../../src/index.ts";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/flows/${name}`, import.meta.url));
}

describe("loadFlow", () => {
  test("imports and validates a flow module", async () => {
    const flow = await loadFlow(fixture("valid.ts"));
    expect(flow.name).toBe("greet");
    expect(flow.entry).toBe("ask");
    expect(flow.steps).toHaveLength(3);
  });

  test("names the file when a module has no default export", async () => {
    const path = fixture("no-default.ts");
    await expect(loadFlow(path)).rejects.toThrow(/no default export/);
    await expect(loadFlow(path)).rejects.toThrow(path);
  });

  test("names the file when a module throws on import", async () => {
    const path = fixture("throws.ts");
    await expect(loadFlow(path)).rejects.toThrow(/import failed/);
    await expect(loadFlow(path)).rejects.toThrow(/explodes on import/);
    await expect(loadFlow(path)).rejects.toThrow(path);
  });

  test("names the file and the invalid step field", async () => {
    const path = fixture("invalid.ts");
    await expect(loadFlow(path)).rejects.toThrow(path);
    await expect(loadFlow(path)).rejects.toThrow(/step "ask"/);
    await expect(loadFlow(path)).rejects.toThrow(/no edge for result "interrupted"/);
  });
});
