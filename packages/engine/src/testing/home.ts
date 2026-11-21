/** A home with a config file, for a test only. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempRoot } from "./fs.ts";

export interface TestHome {
  readonly root: string;
  readonly home: string;
  readonly storeRoot: string;
}

export interface MakeHomeOptions {
  /** The config's `plugins` value. Default: an empty list. */
  readonly plugins?: unknown;
  /** More top-level config fields; a `store` here replaces the default. */
  readonly extra?: Record<string, unknown>;
  /** The scratch directory's prefix. */
  readonly prefix?: string;
}

/**
 * A scratch root and a home under it, with `config.json` naming a SQLite store
 * under the root. The caller adds the files the test needs.
 */
export async function makeHome(
  options: MakeHomeOptions = {},
): Promise<TestHome> {
  const root = await tempRoot(options.prefix ?? "operad-home-test-");
  const home = join(root, "home");
  const storeRoot = join(root, "store");
  await mkdir(home, { recursive: true });
  const config: Record<string, unknown> = {
    plugins: options.plugins ?? [],
    store: { backend: "sqlite", path: join(storeRoot, "log.sqlite") },
    ...options.extra,
  };
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  return { root, home, storeRoot };
}
