/** A plugin store backed by one SQLite file, in the same home as the log. */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { enableWal, setBusyTimeout, writeImmediate } from "../platform/index.ts";
import { dirname, join } from "node:path";
import {
  followsChanges,
  type FollowOptions,
} from "../platform/index.ts";
import {
  assertWhere,
  CursorError,
  decodeCursor,
  encodeCursor,
  matchesWhere,
  pageLimit,
  whereFingerprint,
} from "./paging.ts";
import type {
  StoreFactInput,
  FactsOptions,
  FactsPage,
  ListOptions,
  ListPage,
  ObjectData,
  ObjectRef,
  PluginFact,
  PluginStore,
  PluginStoreLocation,
  StoredObject,
} from "./types.ts";
import { isRecord, requireName } from "../util.ts";
import { repeatEvery } from "../util.ts";
import {
  diffObject,
  isObjectFact,
  OBJECT_CHANGE_FACT,
  type ObjectChange,
} from "./object-facts.ts";

export interface SqlitePluginStoreOptions extends FollowOptions {
  readonly root: string;
  /** The database file; defaults to `<root>/plugins.sqlite`. */
  readonly file?: string | undefined;
  readonly clock?: (() => number) | undefined;
  /**
   * Starts a repeating timer that calls `callback` every `ms` and returns a
   * stop function. Defaults to `setInterval`. A test passes a stub it fires by
   * hand, so no test waits on wall time.
   */
  readonly repeat?:
    | ((ms: number, callback: () => void) => () => void)
    | undefined;
}

interface ObjectRow {
  readonly type: string;
  readonly id: string;
  readonly data: string;
  readonly version: number;
  readonly cause: string;
  readonly at: number;
}

interface FactRow {
  readonly sequence: number;
  readonly type: string;
  readonly object_type: string | null;
  readonly object_id: string | null;
  readonly cause: string;
  readonly at: number;
  readonly data: string;
}

interface Subscription {
  readonly key: string;
  readonly after: number;
  readonly listener: (fact: PluginFact) => void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS objects (
    type    TEXT NOT NULL,
    id      TEXT NOT NULL,
    data    TEXT NOT NULL,
    version INTEGER NOT NULL,
    cause   TEXT NOT NULL,
    at      INTEGER NOT NULL,
    PRIMARY KEY (type, id)
  );
  CREATE TABLE IF NOT EXISTS facts (
    sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    object_type TEXT,
    object_id   TEXT,
    cause       TEXT NOT NULL,
    at          INTEGER NOT NULL,
    data        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS facts_by_object
    ON facts (object_type, object_id, sequence);
  CREATE INDEX IF NOT EXISTS facts_by_object_id
    ON facts (object_id, object_type);
  CREATE TABLE IF NOT EXISTS declared_index (
    type  TEXT NOT NULL,
    field TEXT NOT NULL,
    PRIMARY KEY (type, field)
  );
  CREATE TABLE IF NOT EXISTS declared_types (
    type TEXT PRIMARY KEY
  );
`;

const SCHEMA_FILE = "plugins.sqlite";

/**
 * The plugin store's schema version. Version 1 wrote a whole object snapshot
 * on every put; version 2 writes the changed fields and the removed names.
 */
export const PLUGIN_STORE_SCHEMA_VERSION = 2;

interface VersionRow {
  readonly version: number;
}

interface ObjectKeyRow {
  readonly type: string;
  readonly id: string;
}

interface SnapshotRow {
  readonly sequence: number;
  readonly data: string;
}

function readSchemaVersion(database: Database): number | undefined {
  try {
    const row = database
      .query<VersionRow, []>("SELECT version FROM schema_version WHERE id = 1")
      .get();
    return row !== null && Number.isInteger(row.version) ? row.version : undefined;
  } catch {
    return undefined;
  }
}

function hasTable(database: Database, name: string): boolean {
  return (
    database
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

/**
 * Rewrites every old full-snapshot put fact as a change, one transaction per
 * object, keeping its sequence, cause and time. A run that finds an object
 * already rewritten leaves it alone, so the migration is safe to repeat.
 */
function migrateObjectFacts(database: Database): void {
  const objects = database
    .query<ObjectKeyRow, []>(
      `SELECT DISTINCT object_type AS type, object_id AS id
       FROM facts
       WHERE object_type IS NOT NULL AND object_id IS NOT NULL
         AND type = object_type
       ORDER BY object_type, object_id`,
    )
    .all();
  const snapshots = database.prepare(
    `SELECT sequence, data FROM facts
     WHERE object_type = ? AND object_id = ? AND type = ?
     ORDER BY sequence`,
  );
  const update = database.prepare("UPDATE facts SET type = ?, data = ? WHERE sequence = ?");
  for (const object of objects) {
    writeImmediate(database, () => {
      const rows = snapshots.all(object.type, object.id, object.type) as SnapshotRow[];
      if (rows.length === 0) return;
      let previous: ObjectData | undefined;
      for (const row of rows) {
        const data = parseData(row.data);
        const change: ObjectChange =
          previous === undefined
            ? { changed: data, removed: [] }
            : (diffObject(previous, data) ?? { changed: {}, removed: [] });
        update.run(OBJECT_CHANGE_FACT, JSON.stringify(change), row.sequence);
        previous = data;
      }
    });
  }
}

function ensureSchema(database: Database, file: string): void {
  let version = readSchemaVersion(database);
  if (version === undefined) {
    // A store with tables but no version was written before this version
    // existed: its full-snapshot facts are version 1. A fresh store starts at
    // the current version. The immediate transaction makes two processes
    // opening the file at once wait, then find it done.
    const old = hasTable(database, "facts") || hasTable(database, "objects");
    database
      .transaction(() => {
        database.exec(SCHEMA);
        database.run("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ?)", [
          old ? 1 : PLUGIN_STORE_SCHEMA_VERSION,
        ]);
      })
      .immediate();
    version = readSchemaVersion(database);
  }
  if (version === undefined) {
    throw new Error(`plugin store ${file} has no valid schema_version`);
  }
  if (version > PLUGIN_STORE_SCHEMA_VERSION) {
    throw new Error(
      `plugin store ${file} uses schema_version ${version}, but this build supports ` +
        `${PLUGIN_STORE_SCHEMA_VERSION}; upgrade operad to open it`,
    );
  }
  // Repair a base table or index a store lost; every statement is IF NOT EXISTS.
  database.exec(SCHEMA);
  if (version < PLUGIN_STORE_SCHEMA_VERSION) {
    migrateObjectFacts(database);
    writeImmediate(database, () => {
      database.run("UPDATE schema_version SET version = ? WHERE id = 1", [
        PLUGIN_STORE_SCHEMA_VERSION,
      ]);
    });
    version = readSchemaVersion(database);
  }
  if (version !== PLUGIN_STORE_SCHEMA_VERSION) {
    throw new Error(
      `plugin store ${file} uses schema_version ${String(version)}, but this build ` +
        `requires ${PLUGIN_STORE_SCHEMA_VERSION}`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

function parseData(text: string): ObjectData {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** A durable object store for a home configured with the sqlite backend. */
export class SqlitePluginStore implements PluginStore {
  readonly kind = "file" as const;
  readonly root: string;
  readonly location: PluginStoreLocation;
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly follow: boolean;
  private readonly repeat: (ms: number, callback: () => void) => () => void;
  private readonly listeners = new Set<(object: ObjectRef) => void>();
  private readonly factListeners = new Set<Subscription>();
  /** The last sequence any subscription has been told about. */
  private polledSequence = 0;
  private stopPoll: (() => void) | undefined;
  /** The objects `list` last read, by type and id; frozen, so sharing is safe. */
  private readonly listed = new Map<string, Map<string, StoredObject>>();

  constructor(options: SqlitePluginStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
    this.follow = followsChanges(options);
    this.repeat = options.repeat ?? repeatEvery;
    const file = options.file ?? join(options.root, SCHEMA_FILE);
    this.location = { backend: "sqlite", root: options.root, file };
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    try {
      setBusyTimeout(this.db);
      enableWal(this.db);
      ensureSchema(this.db, file);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Record the type and its index fields. Every command loads the plugins and
   * so calls this, `list` among them: it writes only when the stored
   * declaration differs, so a command that only reads never waits for the
   * write lock a running `serve` keeps taking (and never fails with "database
   * is locked" when serve holds it past the busy timeout). A change is one
   * transaction, so a reader never sees the index half replaced.
   */
  declare(type: string, index: readonly string[]): void {
    const fields = [...new Set(index)].sort();
    const stored = this.declaredIndex(type);
    if (
      stored !== undefined &&
      stored.length === fields.length &&
      stored.every((field, position) => field === fields[position])
    ) {
      return;
    }
    writeImmediate(this.db, () => {
      this.db
        .query("INSERT OR IGNORE INTO declared_types (type) VALUES (?)")
        .run(type);
      this.db.query("DELETE FROM declared_index WHERE type = ?").run(type);
      const insert = this.db.query(
        "INSERT OR IGNORE INTO declared_index (type, field) VALUES (?, ?)",
      );
      for (const field of fields) insert.run(type, field);
    });
  }

  put(type: string, id: string, data: ObjectData, cause: string): StoredObject {
    requireName(type, "object type");
    requireName(id, "object id");
    requireName(cause, "cause");
    const previous = this.get(type, id);
    let change: ObjectChange;
    if (previous === undefined) {
      change = { changed: { ...data }, removed: [] };
    } else {
      // An unchanged put still records its cause: dev's attempts table reads
      // the cause of a step's put even when the step changed no field.
      change = diffObject(previous.data, data) ?? { changed: {}, removed: [] };
    }
    const object: StoredObject = {
      type,
      id,
      data: { ...data },
      version: (previous?.version ?? 0) + 1,
      cause,
      at: this.clock(),
    };
    writeImmediate(this.db, () => {
      this.db
        .query(
          `INSERT INTO objects (type, id, data, version, cause, at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (type, id) DO UPDATE SET
             data = excluded.data,
             version = excluded.version,
             cause = excluded.cause,
             at = excluded.at`,
        )
        .run(
          type,
          id,
          JSON.stringify(object.data),
          object.version,
          cause,
          object.at,
        );
      this.insertFact({ type: OBJECT_CHANGE_FACT, object: { type, id }, data: change, cause });
    });
    return object;
  }

  get(type: string, id: string): StoredObject | undefined {
    const row = this.db
      .query("SELECT type, id, data, version, cause, at FROM objects WHERE type = ? AND id = ?")
      .get(type, id) as ObjectRow | null;
    return row === null ? undefined : this.objectOf(row);
  }

  list(type: string, options: ListOptions = {}): ListPage {
    this.assertWhere(type, options);
    const fingerprint = whereFingerprint(options.where ?? {});
    let after: string | undefined;
    if (options.cursor !== undefined) {
      const cursor = decodeCursor(options.cursor, `list "${type}"`);
      if (cursor.kind !== "list") {
        throw new CursorError(`list "${type}": invalid cursor`);
      }
      if (cursor.type !== type) {
        throw new CursorError(
          `list "${type}": the cursor belongs to object type "${String(cursor.type)}"`,
        );
      }
      if (cursor.where !== fingerprint) {
        throw new CursorError(
          `list "${type}": the cursor was made for a different filter`,
        );
      }
      if (typeof cursor.after !== "string") {
        throw new CursorError(`list "${type}": invalid cursor`);
      }
      after = cursor.after;
    }

    // Read from the cursor on and stop once a page and one more are found. The
    // scan reads each row's version, not its data: an object whose version,
    // time and cause match the remembered copy is not read or parsed again, so
    // a page costs what changed in it, not what it holds.
    const statement = this.db.prepare(
      "SELECT type, id, version, cause, at FROM objects WHERE type = ? AND id > ? ORDER BY id",
    );
    const limit = pageLimit(options.limit);
    const objects: StoredObject[] = [];
    const remembered = this.listed.get(type) ?? new Map<string, StoredObject>();
    this.listed.set(type, remembered);
    try {
      for (const row of statement.iterate(type, after ?? "") as IterableIterator<
        Omit<ObjectRow, "data">
      >) {
        let object = remembered.get(row.id);
        if (
          object === undefined ||
          object.version !== row.version ||
          object.at !== row.at ||
          object.cause !== row.cause
        ) {
          const full = this.get(type, row.id);
          if (full === undefined) continue;
          object = deepFreeze(full);
          remembered.set(row.id, object);
        }
        if (!matchesWhere(object.data, options.where)) continue;
        objects.push(object);
        if (objects.length > limit) break;
      }
    } finally {
      statement.finalize();
    }
    const more = objects.length > limit;
    if (more) objects.length = limit;
    const last = objects.at(-1);
    return {
      objects,
      ...(more && last !== undefined
        ? {
            next: encodeCursor({
              kind: "list",
              type,
              after: last.id,
              where: fingerprint,
            }),
          }
        : {}),
    };
  }

  objectTypesOf(id: string): readonly string[] {
    const rows = this.db
      .query(
        "SELECT DISTINCT object_type FROM facts WHERE object_id = ? AND object_type IS NOT NULL ORDER BY object_type",
      )
      .all(id) as { object_type: string }[];
    return rows.map((row) => row.object_type);
  }

  facts(): readonly PluginFact[];
  facts(object: ObjectRef, options?: FactsOptions): FactsPage;
  facts(
    object?: ObjectRef,
    options: FactsOptions = {},
  ): readonly PluginFact[] | FactsPage {
    if (object === undefined) {
      const rows = this.db
        .query(
          "SELECT sequence, type, object_type, object_id, cause, at, data FROM facts ORDER BY sequence",
        )
        .all() as FactRow[];
      return rows.map((row) => this.factOf(row));
    }

    const after = this.factCursor(object, options.cursor);
    const limit = pageLimit(options.limit);
    const rows = this.db
      .query(
        `SELECT sequence, type, object_type, object_id, cause, at, data
         FROM facts
         WHERE object_type = ? AND object_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(object.type, object.id, after, limit + 1) as FactRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => this.factOf(row));
    const last = page.at(-1);
    return {
      facts: page,
      ...(more && last !== undefined
        ? {
            next: encodeCursor({
              kind: "facts",
              type: object.type,
              id: object.id,
              after: last.sequence,
            }),
          }
        : {}),
    };
  }

  subscribe(listener: (object: ObjectRef) => void): () => void;
  subscribe(
    object: ObjectRef,
    options: FactsOptions,
    listener: (fact: PluginFact) => void,
  ): () => void;
  subscribe(
    objectOrListener: ObjectRef | ((object: ObjectRef) => void),
    options: FactsOptions = {},
    factListener?: (fact: PluginFact) => void,
  ): () => void {
    if (typeof objectOrListener !== "function") {
      if (factListener === undefined) {
        throw new Error("subscribe: a fact listener is required");
      }
      return this.subscribeFacts(objectOrListener, options, factListener);
    }
    this.listeners.add(objectOrListener);
    this.ensurePolling();
    return () => {
      this.listeners.delete(objectOrListener);
      this.releasePolling();
    };
  }

  subscribeFacts(
    object: ObjectRef,
    options: FactsOptions,
    listener: (fact: PluginFact) => void,
  ): () => void {
    const key = this.key(object.type, object.id);
    let after = this.factCursor(object, options.cursor);
    if (options.cursor === undefined) {
      const last = this.db
        .query(
          "SELECT sequence FROM facts WHERE object_type = ? AND object_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(object.type, object.id) as { sequence: number } | null;
      after = last?.sequence ?? 0;
    }
    const existing = this.db
      .query(
        `SELECT sequence, type, object_type, object_id, cause, at, data
         FROM facts
         WHERE object_type = ? AND object_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(object.type, object.id, after) as FactRow[];
    let replayed = 0;
    for (const row of existing) {
      const fact = this.factOf(row);
      listener(fact);
      replayed = Math.max(replayed, fact.sequence);
    }
    this.polledSequence = Math.max(this.polledSequence, replayed);
    const subscription: Subscription = { key, after, listener };
    this.factListeners.add(subscription);
    this.ensurePolling();
    return () => {
      this.factListeners.delete(subscription);
      this.releasePolling();
    };
  }

  append(input: StoreFactInput): PluginFact {
    return writeImmediate(this.db, () => this.insertFact(input));
  }

  private insertFact(input: StoreFactInput): PluginFact {
    requireName(input.type, "fact type");
    const cause = input.cause;
    requireName(cause, "cause");
    const at = this.clock();
    const result = this.db
      .query(
        "INSERT INTO facts (type, object_type, object_id, cause, at, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.type,
        input.object?.type ?? null,
        input.object?.id ?? null,
        cause,
        at,
        JSON.stringify(input.data),
      );
    const fact: PluginFact = {
      sequence: Number(result.lastInsertRowid),
      type: input.type,
      object: input.object,
      cause,
      at,
      data: { ...input.data },
    };
    if (fact.object !== undefined) {
      for (const listener of this.listeners) listener(fact.object);
    }
    this.polledSequence = Math.max(this.polledSequence, fact.sequence);
    this.notifyFacts(fact);
    return fact;
  }

  /** Closes the database; tests open many homes. */
  close(): void {
    this.stopPoll?.();
    this.stopPoll = undefined;
    this.db.close();
  }

  /** Polls for facts another connection committed; SQLite has no notification. */
  private ensurePolling(): void {
    if (!this.follow) return;
    if (this.factListeners.size === 0 && this.listeners.size === 0) return;
    if (this.stopPoll !== undefined) return;
    if (this.factListeners.size === 0) {
      this.polledSequence = Math.max(this.polledSequence, this.maxSequence());
    }
    this.stopPoll = this.repeat(25, () => this.pollFacts());
  }

  private releasePolling(): void {
    if (this.factListeners.size > 0 || this.listeners.size > 0) return;
    this.stopPoll?.();
    this.stopPoll = undefined;
  }

  private maxSequence(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM facts")
      .get() as { sequence: number };
    return row.sequence;
  }

  private pollFacts(): void {
    // A removed database has nothing left to deliver; its timer outlives it.
    if (!existsSync(this.location.file ?? this.root)) return;
    const rows = this.db
      .query(
        `SELECT sequence, type, object_type, object_id, cause, at, data
         FROM facts
         WHERE sequence > ?
         ORDER BY sequence`,
      )
      .all(this.polledSequence) as FactRow[];
    for (const row of rows) {
      const fact = this.factOf(row);
      this.polledSequence = Math.max(this.polledSequence, fact.sequence);
      if (isObjectFact(fact)) {
        for (const listener of this.listeners) listener(fact.object);
      }
      this.notifyFacts(fact);
    }
  }

  private notifyFacts(fact: PluginFact): void {
    if (fact.object === undefined) return;
    const key = this.key(fact.object.type, fact.object.id);
    for (const subscription of this.factListeners) {
      if (subscription.key !== key) continue;
      if (fact.sequence <= subscription.after) continue;
      subscription.listener(fact);
    }
  }

  private objectOf(row: ObjectRow): StoredObject {
    return {
      type: row.type,
      id: row.id,
      data: parseData(row.data),
      version: row.version,
      cause: row.cause,
      at: row.at,
    };
  }

  private factOf(row: FactRow): PluginFact {
    return {
      sequence: row.sequence,
      type: row.type,
      object:
        row.object_type === null || row.object_id === null
          ? undefined
          : { type: row.object_type, id: row.object_id },
      cause: row.cause,
      at: row.at,
      data: parseData(row.data),
    };
  }

  private assertWhere(type: string, options: ListOptions): void {
    if (options.where === undefined) return;
    const declared = options.index ?? this.declaredIndex(type);
    if (declared === undefined) {
      assertWhere(Object.keys(options.where), options.where, `list "${type}"`);
      return;
    }
    assertWhere(declared, options.where, `list "${type}"`);
  }

  private declaredIndex(type: string): readonly string[] | undefined {
    const declared = this.db
      .query("SELECT 1 AS present FROM declared_types WHERE type = ?")
      .get(type);
    if (declared === null) return undefined;
    const rows = this.db
      .query("SELECT field FROM declared_index WHERE type = ? ORDER BY field")
      .all(type) as { field: string }[];
    return rows.map((row) => row.field);
  }

  private factCursor(object: ObjectRef, cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const label = `facts "${object.type}:${object.id}"`;
    const value = decodeCursor(cursor, label);
    if (value.kind !== "facts") {
      throw new CursorError(`${label}: invalid cursor`);
    }
    if (value.type !== object.type || value.id !== object.id) {
      throw new CursorError(
        `${label}: the cursor belongs to "${String(value.type)}:${String(value.id)}"`,
      );
    }
    if (typeof value.after !== "number" || !Number.isInteger(value.after)) {
      throw new CursorError(`${label}: invalid cursor`);
    }
    return value.after;
  }

  private key(type: string, id: string): string {
    return `${type}\u0000${id}`;
  }
}
