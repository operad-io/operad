/** Opening a log by backend name, without reading repository configuration. */

import { openSqliteLogBackend } from "./sqlite.ts";
import type { LogBackend, LogBackendOptions } from "./types.ts";

export type LogBackendName = "sqlite";

export interface OpenLogOptions extends LogBackendOptions {
  readonly backend: LogBackendName;
  /** The database file. */
  readonly path: string;
}

/** Open the log a store uses. The caller decides the backend; this reads no config. */
export function openLog(options: OpenLogOptions): LogBackend {
  return openSqliteLogBackend(options.path, options);
}
