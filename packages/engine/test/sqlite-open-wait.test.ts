import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { enableWal } from "../src/platform/sqlite-open.ts";

class BusyError extends Error {
  readonly code = "SQLITE_BUSY";
}

interface Waiter {
  transaction: (work: () => unknown) => { immediate(): unknown };
}

// A stand-in for a store whose other writer keeps committing: the switch to WAL
// and the first `busyWaits` waits for the write lock end in SQLITE_BUSY while
// the data version advances; the next wait gets the lock.
function busyStore(busyWaits: number): { database: Database; waits: () => number } {
  let mode = "delete";
  let version = 0;
  let waits = 0;
  const stub = {
    query(sql: string) {
      return {
        get(): unknown {
          if (sql === "PRAGMA journal_mode") return { journal_mode: mode };
          if (sql === "PRAGMA data_version") return { data_version: version };
          if (sql === "PRAGMA journal_mode = WAL") {
            if (waits > busyWaits) {
              mode = "wal";
              return { journal_mode: mode };
            }
            throw new BusyError("database is locked");
          }
          throw new Error(`unexpected query ${sql}`);
        },
      };
    },
    transaction<T>(work: () => T) {
      return {
        immediate(): T {
          waits += 1;
          if (waits <= busyWaits) {
            version += 1; // the other writer committed while this one waited
            throw new BusyError("database is locked");
          }
          mode = "wal";
          return work();
        },
      };
    },
  };
  return { database: stub as unknown as Database, waits: () => waits };
}

test("switching to WAL keeps waiting while the other writer keeps committing", () => {
  const { database, waits } = busyStore(3);
  enableWal(database);
  expect(waits()).toBe(4);
});

test("switching to WAL gives up when the lock holder commits nothing", () => {
  const { database } = busyStore(3);
  (database as unknown as Waiter).transaction = () => ({
    immediate: () => {
      throw new BusyError("database is locked");
    },
  });
  expect(() => enableWal(database)).toThrow("database is locked");
});
