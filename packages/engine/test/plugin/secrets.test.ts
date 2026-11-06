import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FileSecretStore,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  Secret,
  SecretSerializationError,
  secretsDirectory,
  secretsPathFor,
  type JsonValue,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

async function filesUnder(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

describe("plugin secrets", () => {
  test("set/get round-trips and writes 0600 in a 0700 directory", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const store = new FileSecretStore({ home, plugin: "notes" });

    await store.set("token", "s3cr3t");
    const found = await store.get("token");
    expect(found).toBeInstanceOf(Secret);
    expect(found?.reveal()).toBe("s3cr3t");
    expect(await store.names()).toEqual(["token"]);

    const directory = await stat(secretsDirectory(home));
    expect(directory.mode & 0o777).toBe(0o700);
    const file = await stat(secretsPathFor(home, "notes"));
    expect(file.mode & 0o777).toBe(0o600);
    expect(await readFile(secretsPathFor(home, "notes"), "utf8")).toContain("s3cr3t");

    await store.delete("token");
    expect(await store.get("token")).toBeUndefined();
  });

  test("a step can read a secret without it reaching facts, history or the log files", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const storeRoot = join(root, "store");
    const value = "never-store-this-value";
    await new FileSecretStore({ home, plugin: "notes" }).set("token", value);

    const plugin = def({
      name: "notes",
      steps: [
        {
          name: "use",
          results: ["ok"],
          async run(ctx) {
            const secret = await ctx.secrets.get("token");
            await ctx.facts.append({
              type: "secret_used",
              data: { present: secret !== undefined },
            });
            return { result: "ok" };
          },
        },
      ],
    });
    const stores = new MemoryPluginStore({ root: storeRoot });
    const registry = new PluginRegistry([plugin], {
      home,
      store: stores,
      onLog: () => undefined,
    });
    await registry.runStep("notes/use", {}, { runId: "run-1" });

    expect(process.env[value]).toBeUndefined();
    expect(JSON.stringify(stores.facts())).not.toContain(value);
    for (const file of await filesUnder(storeRoot)) {
      if (!/\.(jsonl|json|txt|log)$/.test(file)) continue;
      expect(await readFile(file, "utf8")).not.toContain(value);
    }
  });

  test("putting a Secret into the log is refused", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "jsonl", path: join(root, "log") });
    try {
      const info = await log.startRun("flow", "object");
      await expect(
        log.append(info.runId, 0, [
          {
            kind: "leak",
            cause: "test",
            payload: { secret: new Secret("value") } as unknown as JsonValue,
          },
        ]),
      ).rejects.toBeInstanceOf(SecretSerializationError);
    } finally {
      await log.close();
    }
  });
});
