import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePluginStore } from "../../src/plugin/sqlite-store.ts";

const HOLD_CHILD = join(import.meta.dir, "..", "fixtures", "sqlite-hold.ts");
const PUT_CHILD = join(import.meta.dir, "..", "fixtures", "plugin-store-put.ts");
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "operad-plugin-store-"));
  directories.push(directory);
  return join(directory, "plugins.sqlite");
}

function journalMode(file: string): string | undefined {
  const database = new Database(file);
  try {
    return database
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()?.journal_mode;
  } finally {
    database.close();
  }
}

/** Reads JSON lines from a child's stdout one at a time. */
function lines(stream: ReadableStream<Uint8Array>): () => Promise<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return async () => {
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        return JSON.parse(line);
      }
      const { value, done } = await reader.read();
      if (value !== undefined) text += decoder.decode(value, { stream: true });
      if (done && text.indexOf("\n") < 0) throw new Error("the child ended early");
    }
  };
}

test("a store created in delete mode is WAL after it is opened", () => {
  const file = tempFile();
  const old = new Database(file);
  old.run("CREATE TABLE seed (x)");
  expect(old.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
  old.close();

  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  store.close();
  expect(journalMode(file)).toBe("wal");
});

test("a write waits for another process's write transaction and succeeds after it commits", async () => {
  const file = tempFile();
  new SqlitePluginStore({ root: join(file, ".."), file }).close();
  const env = { ...process.env, OPERAD_DB_PATH: file };
  const holder = Bun.spawn([process.execPath, HOLD_CHILD], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const holderLines = lines(holder.stdout);
    expect(await holderLines()).toEqual({ locked: true });
    const writer = Bun.spawn([process.execPath, PUT_CHILD], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const writerLines = lines(writer.stdout);
      expect(await writerLines()).toEqual({ writing: true });
      // The holder still holds its lock, so the writer cannot have finished.
      expect(writer.exitCode).toBeNull();
      holder.stdin.write("release\n");
      await holder.stdin.end();
      expect(await writerLines()).toEqual({ written: true });
      expect(await writer.exited).toBe(0);
    } finally {
      if (writer.exitCode === null) writer.kill();
      await writer.exited;
    }
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
  }
  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  expect(store.get("note", "one")?.data).toEqual({ text: "hello" });
  store.close();
});
