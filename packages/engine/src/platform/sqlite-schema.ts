/** Reading a SQLite file's schema version and tables, for both sqlite stores. */

import type { Database } from "bun:sqlite";

interface VersionRow {
  readonly version: number;
}

/** The recorded version, or undefined when the schema has not been created yet. */
export function readSchemaVersion(database: Database): number | undefined {
  try {
    const row = database
      .query<VersionRow, []>("SELECT version FROM schema_version WHERE id = 1")
      .get();
    return row !== null && Number.isInteger(row.version) ? row.version : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the database has a table with this name. */
export function hasTable(database: Database, name: string): boolean {
  return (
    database
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}
