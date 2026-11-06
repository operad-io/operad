/** A plugin store backed by one SQLite file, in the same home as the log. */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  FactInput,
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

export interface SqlitePluginStoreOptions {
  readonly root: string;
  /** The database file; defaults to `<root>/plugins.sqlite`. */
  readonly file?: string | undefined;
  readonly clock?: (() => number) | undefined;
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
  CREATE TABLE IF NOT EXISTS declared_index (
    type  TEXT NOT NULL,
    field TEXT NOT NULL,
    PRIMARY KEY (type, field)
  );
  CREATE TABLE IF NOT EXISTS declared_types (
    type TEXT PRIMARY KEY
  );
`;

const SCHEMA_FILE = "plugin.sqlite";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireName(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field}: must be a non-empty string`);
  }
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
  private readonly listeners = new Set<(object: ObjectRef) => void>();
  private readonly factListeners = new Set<Subscription>();
  /** The last sequence any subscription has been told about. */
  private polledSequence = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SqlitePluginStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
    const file = options.file ?? join(options.root, SCHEMA_FILE);
    this.location = { backend: "sqlite", root: options.root, file };
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec(SCHEMA);
  }

  declare(type: string, index: readonly string[]): void {
    this.db
      .query("INSERT OR IGNORE INTO declared_types (type) VALUES (?)")
      .run(type);
    this.db.query("DELETE FROM declared_index WHERE type = ?").run(type);
    const insert = this.db.query(
      "INSERT OR IGNORE INTO declared_index (type, field) VALUES (?, ?)",
    );
    for (const field of index) insert.run(type, field);
  }

  put(type: string, id: string, data: ObjectData, cause: string): StoredObject {
    requireName(type, "object type");
    requireName(id, "object id");
    requireName(cause, "cause");
    const previous = this.get(type, id);
    const object: StoredObject = {
      type,
      id,
      data: { ...data },
      version: (previous?.version ?? 0) + 1,
      cause,
      at: this.clock(),
    };
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
    this.append({ type, object: { type, id }, data, cause });
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

    const rows = this.db
      .query("SELECT type, id, data, version, cause, at FROM objects WHERE type = ? ORDER BY id")
      .all(type) as ObjectRow[];
    const limit = pageLimit(options.limit);
    const objects: StoredObject[] = [];
    for (const row of rows) {
      if (after !== undefined && row.id <= after) continue;
      const object = this.objectOf(row);
      if (!matchesWhere(object.data, options.where)) continue;
      objects.push(object);
      if (objects.length > limit) break;
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

  append(input: FactInput): PluginFact {
    requireName(input.type, "fact type");
    const cause = input.cause;
    if (cause === undefined) {
      throw new Error("cause: must be a non-empty string");
    }
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
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.db.close();
  }

  /** Polls for facts another connection committed; SQLite has no notification. */
  private ensurePolling(): void {
    if (this.factListeners.size === 0 && this.listeners.size === 0) return;
    if (this.pollTimer !== undefined) return;
    if (this.factListeners.size === 0) {
      this.polledSequence = Math.max(this.polledSequence, this.maxSequence());
    }
    this.pollTimer = setInterval(() => this.pollFacts(), 25);
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  private releasePolling(): void {
    if (this.factListeners.size > 0 || this.listeners.size > 0) return;
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private maxSequence(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM facts")
      .get() as { sequence: number };
    return row.sequence;
  }

  private pollFacts(): void {
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
      if (fact.object !== undefined && fact.type === fact.object.type) {
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
