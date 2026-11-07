/** A plugin store that keeps its facts in one append-only JSONL file. */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { watchDirectory } from "../platform/index.ts";
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

/** How often an open subscription re-reads the file by default. */
export const DEFAULT_STORE_POLL_MS = 500;

function repeatEvery(ms: number, callback: () => void): () => void {
  const timer = setInterval(callback, ms);
  // A subscription must not keep the process alive by itself.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
  };
}

export interface FilePluginStoreOptions {
  readonly root: string;
  readonly clock?: (() => number) | undefined;
  /**
   * How often an open subscription re-reads the file for another writer's
   * facts, in milliseconds. Defaults to 500. The watch is the fast path; this
   * check is the one that cannot miss a write the watch does not report.
   */
  readonly pollMs?: number | undefined;
  /**
   * Starts a repeating timer that calls `callback` every `ms` and returns a
   * stop function. Defaults to `setInterval`. A test passes a stub it fires by
   * hand, so no test waits on wall time.
   */
  readonly repeat?:
    | ((ms: number, callback: () => void) => () => void)
    | undefined;
  /**
   * Watches a directory for another writer's facts and returns a stop function.
   * Defaults to `fs.watch`. A test passes a stub that never fires.
   */
  readonly watch?:
    | ((
        directory: string,
        onChange: (filename: string | null) => void,
      ) => () => void)
    | undefined;
}

/** A lock older than this belongs to a writer that died while holding it. */
const LOCK_STALE_MS = 10_000;

interface FactSubscription {
  readonly key: string;
  readonly after: number;
  readonly listener: (fact: PluginFact) => void;
}

function requireName(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field}: must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Waits without spinning the CPU; appends hold the lock for microseconds. */
function sleepSync(ms: number): void {
  Bun.sleepSync(ms);
}

function parseFact(value: unknown): PluginFact | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = value.sequence;
  const type = value.type;
  const cause = value.cause;
  const at = value.at;
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    typeof type !== "string" ||
    typeof cause !== "string" ||
    typeof at !== "number"
  ) {
    return undefined;
  }
  const object =
    isRecord(value.object) &&
    typeof value.object.type === "string" &&
    typeof value.object.id === "string"
      ? { type: value.object.type, id: value.object.id }
      : undefined;
  const data = isRecord(value.data) ? (value.data as ObjectData) : {};
  return { sequence, type, object, cause, at, data };
}

/**
 * The store the kernel gives plugins in the home: each fact is appended to
 * `<root>/facts.jsonl`, and objects are rebuilt from those facts when the
 * store opens. A torn final line is ignored, as in the log.
 */
export class FilePluginStore implements PluginStore {
  readonly kind = "file" as const;
  readonly root: string;
  readonly location: PluginStoreLocation;
  private readonly clock: () => number;
  private readonly pollMs: number;
  private readonly repeat: (ms: number, callback: () => void) => () => void;
  private readonly watch: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
  private readonly factsPath: string;
  private readonly lockPath: string;
  private readonly objects = new Map<string, Map<string, StoredObject>>();
  private readonly indexes = new Map<string, readonly string[]>();
  private readonly entries: PluginFact[] = [];
  private readonly byObject = new Map<string, PluginFact[]>();
  private readonly listeners = new Set<(object: ObjectRef) => void>();
  private readonly factListeners = new Set<FactSubscription>();
  /** Bytes of the facts file already read; a torn final line stays unread. */
  private offset = 0;
  /** Stops the directory watcher that reports another writer's facts. */
  private stopWatch: (() => void) | undefined;
  /** Stops the fallback check for a write the watch did not report. */
  private stopPoll: (() => void) | undefined;

  constructor(options: FilePluginStoreOptions) {
    this.root = options.root;
    this.location = { backend: "jsonl", root: options.root };
    this.clock = options.clock ?? (() => Date.now());
    this.pollMs = options.pollMs ?? DEFAULT_STORE_POLL_MS;
    this.repeat = options.repeat ?? repeatEvery;
    this.watch = options.watch ?? watchDirectory;
    this.factsPath = join(options.root, "facts.jsonl");
    this.lockPath = join(options.root, "facts.lock");
    mkdirSync(options.root, { recursive: true });
    this.refresh();
  }

  declare(type: string, index: readonly string[]): void {
    this.indexes.set(type, [...index]);
  }

  put(
    type: string,
    id: string,
    data: ObjectData,
    cause: string,
  ): StoredObject {
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
    this.append({ type, object: { type, id }, data, cause });
    return this.get(type, id) ?? object;
  }

  get(type: string, id: string): StoredObject | undefined {
    this.refresh();
    return this.objects.get(type)?.get(id);
  }

  list(type: string, options: ListOptions = {}): ListPage {
    this.refresh();
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

    const byId = this.objects.get(type);
    const ids = byId === undefined ? [] : [...byId.keys()].sort();
    const start = after === undefined ? 0 : ids.findIndex((id) => id > after);

    const objects: StoredObject[] = [];
    const limit = pageLimit(options.limit);
    for (const id of start < 0 ? [] : ids.slice(start)) {
      const object = byId?.get(id);
      if (object === undefined) continue;
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
    this.refresh();
    if (object === undefined) return this.entries;

    const key = this.key(object.type, object.id);
    const after = this.factCursor(object, options.cursor);
    const all = this.byObject.get(key) ?? [];
    const later = all.filter((fact) => fact.sequence > after);
    const limit = pageLimit(options.limit);
    const page = later.slice(0, limit);
    const more = later.length > limit;
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

  /** Every fact in append order. */
  allFacts(): readonly PluginFact[] {
    this.refresh();
    return this.entries;
  }

  /** Tells a listener when an object gains a fact, including another writer's. */
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
    this.ensureWatch();
    return () => {
      this.listeners.delete(objectOrListener);
      this.releaseWatch();
    };
  }

  subscribeFacts(
    object: ObjectRef,
    options: FactsOptions,
    listener: (fact: PluginFact) => void,
  ): () => void {
    this.refresh();
    const key = this.key(object.type, object.id);
    let after = this.factCursor(object, options.cursor);
    if (options.cursor === undefined) {
      const all = this.byObject.get(key) ?? [];
      after = all.at(-1)?.sequence ?? 0;
    }
    for (const fact of this.byObject.get(key) ?? []) {
      if (fact.sequence > after) listener(fact);
    }
    const subscription: FactSubscription = { key, after, listener };
    this.factListeners.add(subscription);
    this.ensureWatch();
    return () => {
      this.factListeners.delete(subscription);
      this.releaseWatch();
    };
  }

  /** Starts the shared directory watcher on the first listener of either kind. */
  private ensureWatch(): void {
    if (this.stopWatch !== undefined) return;
    this.stopWatch = this.watch(this.root, (filename) => {
      if (filename !== null && filename !== "facts.jsonl") return;
      this.refresh();
    });
    // A directory watch is the fast path, but it is not a promise: on macOS a
    // write can land with no event at all while the process is loaded. This
    // timer re-reads the file, so a listener cannot miss the write.
    this.stopPoll = this.repeat(this.pollMs, () => this.refresh());
  }

  /** Stops the watcher once no ordinary and no fact listener remains. */
  private releaseWatch(): void {
    if (this.listeners.size > 0 || this.factListeners.size > 0) return;
    this.stopWatch?.();
    this.stopWatch = undefined;
    this.stopPoll?.();
    this.stopPoll = undefined;
  }

  append(input: StoreFactInput): PluginFact {
    requireName(input.type, "fact type");
    const cause = input.cause;
    requireName(cause, "cause");
    const release = this.lockFacts();
    try {
      // Another writer may have appended since this store last read, so the
      // next sequence is chosen under the lock that the append also holds.
      this.refresh();
      const fact: PluginFact = {
        sequence: (this.entries.at(-1)?.sequence ?? 0) + 1,
        type: input.type,
        object: input.object,
        cause,
        at: this.clock(),
        data: { ...input.data },
      };
      appendFileSync(this.factsPath, `${JSON.stringify(fact)}\n`, "utf8");
      this.refresh();
      return fact;
    } finally {
      release();
    }
  }

  /**
   * Serializes appends across processes, so two writers never pick the same
   * sequence number. The lock is a file created exclusively next to the facts.
   */
  private lockFacts(): () => void {
    const started = Date.now();
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        return () => {
          rmSync(this.lockPath, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      // A writer that died while holding the lock must not block the store.
      let stale = Date.now() - started > LOCK_STALE_MS;
      try {
        const raw: unknown = JSON.parse(readFileSync(this.lockPath, "utf8"));
        const at = isRecord(raw) ? raw.at : undefined;
        if (typeof at === "number" && Date.now() - at > LOCK_STALE_MS) {
          stale = true;
        }
      } catch {
        // A lock being written is not stale on that alone; keep waiting.
      }
      if (stale) {
        rmSync(this.lockPath, { force: true });
        continue;
      }
      sleepSync(1);
    }
  }

  /**
   * Reads the lines another process appended since the last read. A worker
   * step writes its facts here, so the run's process has to see them too.
   */
  private refresh(): void {
    if (!existsSync(this.factsPath)) return;
    if (statSync(this.factsPath).size <= this.offset) return;
    const text = readFileSync(this.factsPath).subarray(this.offset).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    const complete = text.slice(0, end + 1);
    this.offset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.split("\n")) {
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // A torn line from a killed writer is not a fact.
        continue;
      }
      const fact = parseFact(raw);
      if (fact === undefined) continue;
      this.entries.push(fact);
      this.apply(fact);
    }
  }

  private apply(fact: PluginFact): void {
    const object = fact.object;
    if (object === undefined) return;
    this.track(fact);
    if (fact.type !== object.type) return;
    const previous = this.objects.get(object.type)?.get(object.id);
    let byId = this.objects.get(object.type);
    if (byId === undefined) {
      byId = new Map();
      this.objects.set(object.type, byId);
    }
    byId.set(object.id, {
      type: object.type,
      id: object.id,
      data: { ...fact.data },
      version: (previous?.version ?? 0) + 1,
      cause: fact.cause,
      at: fact.at,
    });
    for (const listener of this.listeners) listener(object);
  }

  private track(fact: PluginFact): void {
    const object = fact.object;
    if (object === undefined) return;
    const key = this.key(object.type, object.id);
    const list = this.byObject.get(key);
    if (list === undefined) this.byObject.set(key, [fact]);
    else list.push(fact);
    for (const subscription of this.factListeners) {
      if (subscription.key !== key) continue;
      if (fact.sequence <= subscription.after) continue;
      subscription.listener(fact);
    }
  }

  private assertWhere(type: string, options: ListOptions): void {
    if (options.where === undefined) return;
    const index = options.index ?? this.indexes.get(type);
    if (index === undefined) {
      assertWhere(Object.keys(options.where), options.where, `list "${type}"`);
      return;
    }
    assertWhere(index, options.where, `list "${type}"`);
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
