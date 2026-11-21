/** Opening a log file without reading repository configuration. */

import { openSqliteLogBackend } from "./sqlite.ts";
import type { LogBackend, LogBackendOptions } from "./types.ts";

export interface OpenLogOptions extends LogBackendOptions {
  /** The database file. */
  readonly path: string;
}

/** Open the log a store uses; this reads no config. */
export function openLog(options: OpenLogOptions): LogBackend {
  return openSqliteLogBackend(options.path, options);
}
