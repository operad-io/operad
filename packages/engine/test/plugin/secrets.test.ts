import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqlitePluginStore,
  FileSecretStore,
  formatHistoryEntry,
  historyEntries,
  openLog,
  PluginRegistry,
  Runner,
  Secret,
  SecretSerializationError,
  secretsDirectory,
  secretsPathFor,
  type FlowDefinition,
  type JsonValue,
} from "../../src/index.ts";
import secretPlugin from "../fixtures/plugins/secret-notes.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

const secretPluginPath = fileURLToPath(
  new URL("../fixtures/plugins/secret-notes.ts", import.meta.url),
);

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

  test("a run that uses a secret leaves it out of facts, history, environment and log files", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const storeRoot = join(root, "store");
    const value = "never-store-this-value";
    await new FileSecretStore({ home, plugin: "secret-notes" }).set("token", value);

    const flow: FlowDefinition = {
      name: "secret-flow",
      entry: "use",
      steps: [
        {
          id: "use",
          kind: "plugin",
          params: { use: "secret-notes/use", params: {} },
          replay: "safe",
          next: { ok: "end" },
        },
      ],
    };
    const store = new SqlitePluginStore({ root: storeRoot });
    const registry = new PluginRegistry([secretPlugin], {
      home,
      storeRoot,
      store,
      sources: [secretPluginPath],
      onLog: () => undefined,
    });
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    try {
      const info = await log.startRun(flow.name, "job:1");
      await new Runner({ log, flow, runId: info.runId, registry }).run();

      const facts: unknown[] = [];
      for await (const fact of log.read(info.runId)) facts.push(fact);
      const stored = JSON.stringify(facts);
      expect(stored).not.toContain(value);
      const pluginFacts = JSON.stringify(store.facts());
      expect(pluginFacts).toContain('"present":true');
      expect(pluginFacts).toContain('"leakedInEnv":false');
      expect(pluginFacts).not.toContain(value);

      let history = "";
      for await (const entry of historyEntries(log.read(info.runId))) {
        history += `${formatHistoryEntry(entry)}\n`;
      }
      expect(history).not.toContain(value);

      expect(Object.values(process.env).some((item) => item === value)).toBe(false);
      for (const file of await filesUnder(storeRoot)) {
        expect(await readFile(file, "utf8")).not.toContain(value);
      }
    } finally {
      await log.close();
    }
  });

  test("putting a Secret into the log is refused", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "sqlite", path: join(root, "log", "log.sqlite") });
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
