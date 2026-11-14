import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import {
  guardBackgroundBusy,
  ownFrames,
  recordServeFailure,
  retryWhileBusy,
  tolerateBusy,
} from "../src/serve-guard.ts";

afterAll(cleanupTempRoots);

/** Two connections to one file; the first holds the write lock, the second fails at once with the real busy error. */
async function lockedStore(): Promise<{ write: () => void; release: () => void }> {
  const file = join(await tempRoot(), "store.sqlite");
  const holder = new Database(file);
  holder.run("PRAGMA journal_mode = WAL");
  holder.run("CREATE TABLE t (x)");
  holder.run("BEGIN IMMEDIATE");
  const other = new Database(file);
  other.run("PRAGMA busy_timeout = 0");
  return {
    write: () => {
      other.run("INSERT INTO t (x) VALUES (1)");
    },
    release: () => {
      holder.run("COMMIT");
      holder.close();
      other.close();
    },
  };
}

describe("a busy store does not end serve", () => {
  test("a cleanup step that meets the lock is logged and the next step runs", async () => {
    const store = await lockedStore();
    const lines: string[] = [];
    await tolerateBusy("closing the log", () => store.write(), (line) => lines.push(line));
    expect(lines).toEqual(["serve: closing the log: database is locked; going on"]);
    await expect(
      tolerateBusy("closing the log", () => {
        throw new Error("disk full");
      }, () => undefined),
    ).rejects.toThrow("disk full");
    store.release();
  });

  test("an operation that meets the lock is tried again until it succeeds", async () => {
    const store = await lockedStore();
    const lines: string[] = [];
    let waits = 0;
    const result = await retryWhileBusy(
      "opening the stores",
      async () => {
        if (waits < 2) store.write();
        return "opened";
      },
      {
        log: (line) => lines.push(line),
        wait: async () => {
          waits += 1;
        },
      },
    );
    expect(result).toBe("opened");
    expect(lines).toEqual([
      "serve: opening the stores: database is locked; trying again",
      "serve: opening the stores: database is locked; trying again",
    ]);
    await expect(
      retryWhileBusy("opening the stores", async () => {
        throw new Error("bad schema");
      }, { log: () => undefined, wait: async () => undefined }),
    ).rejects.toThrow("bad schema");
    store.release();
  });

  test("a busy rejection outside any pass is logged, any other one ends the process", async () => {
    const store = await lockedStore();
    const home = await tempRoot();
    const target = new EventEmitter();
    const lines: string[] = [];
    const exits: number[] = [];
    const remove = guardBackgroundBusy({
      home,
      log: (line) => lines.push(line),
      exit: (code) => exits.push(code),
      target: target as NodeJS.Process,
    });
    let busy: unknown;
    try {
      store.write();
    } catch (error) {
      busy = error;
    }
    target.emit("unhandledRejection", busy);
    target.emit("uncaughtException", busy);
    expect(exits).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^serve: .*\(background\): database is locked.*going on$/);
    target.emit("unhandledRejection", new Error("boom"));
    expect(exits).toEqual([1]);
    expect(readFileSync(join(home, "serve.log"), "utf8")).toContain("database is locked");
    remove();
    expect(target.listenerCount("unhandledRejection")).toBe(0);
    store.release();
  });
});

describe("the line an ending serve prints", () => {
  test("names the operation; the stack's own frames go to serve.log, not the line", async () => {
    const home = await tempRoot();
    const error = new Error("boom");
    const line = recordServeFailure(home, "opening the stores", error, () => 0);
    expect(line).toBe("serve: opening the stores: boom");
    const log = readFileSync(join(home, "serve.log"), "utf8");
    expect(log).toContain("1970-01-01T00:00:00.000Z serve: opening the stores: boom");
    expect(log).toMatch(/^ {4}at .*serve-guard\.test\.ts/m);
  });

  test("keeps operad's frames and drops the runtime's and dependencies'", () => {
    const error = new Error("x");
    error.stack = [
      "Error: x",
      "    at a (/repo/packages/cli/src/main.ts:1:1)",
      "    at b (/repo/node_modules/dep/index.js:1:1)",
      "    at c (node:internal/process:1:1)",
      "    at d (/repo/packages/engine/src/loop/serve.ts:2:2)",
    ].join("\n");
    expect(ownFrames(error)).toEqual([
      "at a (/repo/packages/cli/src/main.ts:1:1)",
      "at d (/repo/packages/engine/src/loop/serve.ts:2:2)",
    ]);
  });
});
