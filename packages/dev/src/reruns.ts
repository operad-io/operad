/**
 * How often each test passed only on its own rerun, counted per test name over
 * the whole home. The counts show which flaky tests are worth fixing.
 */

import { join } from "node:path";
import type { ObjectStore } from "@operad-io/engine";
import { withLockFile } from "@operad-io/engine/platform";
import { listAll } from "./model.ts";

const RERUN_TYPE = "rerun-count";

export interface RerunCount {
  readonly name: string;
  readonly count: number;
}

function countOf(data: unknown): RerunCount | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { name, count } = data as { name?: unknown; count?: unknown };
  return typeof name === "string" && typeof count === "number"
    ? { name, count }
    : undefined;
}

/** Adds one pass on rerun for each name. Two processes take turns on a lock file. */
export async function recordRerunPasses(
  store: ObjectStore,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  await withLockFile(
    join(store.root, "dev", "reruns.lock"),
    async () => {
      for (const name of names) {
        const key = Buffer.from(name).toString("hex");
        const current = countOf((await store.get(RERUN_TYPE, key))?.data);
        await store.put(
          RERUN_TYPE,
          key,
          { name, count: (current?.count ?? 0) + 1 },
          "dev:rerun-count",
        );
      }
    },
    { label: "dev reruns", onLog: () => {} },
  );
}

/** Every counted test, the most frequent first, then by name. */
export async function listRerunCounts(
  store: ObjectStore,
): Promise<readonly RerunCount[]> {
  const counts: RerunCount[] = [];
  for (const object of await listAll(store, RERUN_TYPE)) {
    const count = countOf(object.data);
    if (count !== undefined) counts.push(count);
  }
  return counts.sort(
    (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}
