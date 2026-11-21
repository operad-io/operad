/** The sqlite log as a child process's backend module, for the conformance suite. */

import { join } from "node:path";
import { SQLITE_FILE_NAME, openSqliteLogBackend } from "../../src/index.ts";
import type { LogBackendFactory } from "../log-conformance.ts";

const sqliteBackend: LogBackendFactory = {
  name: "sqlite",
  open: (directory, options) =>
    openSqliteLogBackend(join(directory, SQLITE_FILE_NAME), options),
};

export default sqliteBackend;
