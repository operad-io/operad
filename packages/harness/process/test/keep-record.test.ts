import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeptWorker, writeKeptWorker } from "@operad-io/engine/platform";
import { keptRecordAppears } from "../src/process.ts";

test("a kept record that is still empty is not ready, so the reply waits for the whole record", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-keep-record-"));
  try {
    const meta = join(root, "record.json");
    writeFileSync(meta, "");
    expect(readKeptWorker(meta)).toBeUndefined();

    let waits = 0;
    await keptRecordAppears(meta, {
      wait: () => {
        waits += 1;
        writeKeptWorker({
          pid: process.pid,
          token: "t0ken",
          scope: "chat:A",
          key: "same",
          socket: join(root, "record.sock"),
          meta,
          session: null,
          startedAt: 1,
          lastUsedAt: 2,
        });
        return Promise.resolve();
      },
    });

    expect(waits).toBe(1);
    expect(readKeptWorker(meta)?.scope).toBe("chat:A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
