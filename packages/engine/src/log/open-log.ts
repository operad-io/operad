/** Opening a log by backend name, without reading repository configuration. */

import { openJsonlLogBackend } from "./jsonl.ts";
import { openSqliteLogBackend } from "./sqlite.ts";
import type { LogBackend, LogBackendOptions } from "./types.ts";

export type LogBackendName = "jsonl" | "sqlite";

export interface OpenLogOptions extends LogBackendOptions {
  readonly backend: LogBackendName;
  /**
   * Where the log lives: the store directory for `jsonl`, the database file for
   * `sqlite`.
   */
  readonly path: string;
}

/** Open the log a store uses. The caller decides the backend; this reads no config. */
export function openLog(options: OpenLogOptions): LogBackend {
  switch (options.backend) {
    case "jsonl":
      return openJsonlLogBackend(options.path, options);
    case "sqlite":
      return openSqliteLogBackend(options.path, options);
  }
}
