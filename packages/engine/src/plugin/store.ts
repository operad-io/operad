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
  StoredObject,
} from "./types.ts";
import { requireName } from "../util.ts";

/** Options for the in-process plugin store: nothing it keeps survives the process. */
export interface MemoryPluginStoreOptions {
  readonly root: string;
  /** The clock facts use. Tests inject one. */
  readonly clock?: (() => number) | undefined;
}

interface FactSubscription {
  readonly key: string;
  readonly after: number;
  readonly listener: (fact: PluginFact) => void;
}

/**
 * The in-process plugin store, used when no store location is given (tests and
 * one-shot use). It is separate from the run log's storage backends. Each
 * object change and each appended fact is kept in order; `facts()` is the
 * history the kernel's views read.
 */
export class MemoryPluginStore implements PluginStore {
  readonly kind = "memory" as const;
  readonly root: string;
  private readonly clock: () => number;
  private readonly objects = new Map<string, Map<string, StoredObject>>();
  private readonly indexes = new Map<string, readonly string[]>();
  private readonly entries: PluginFact[] = [];
  private readonly byObject = new Map<string, PluginFact[]>();
  private readonly listeners = new Set<(object: ObjectRef) => void>();
  private readonly factListeners = new Set<FactSubscription>();

  constructor(options: MemoryPluginStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
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
    let byId = this.objects.get(type);
    if (byId === undefined) {
      byId = new Map();
      this.objects.set(type, byId);
    }
    byId.set(id, object);
    this.append({ type, object: { type, id }, data, cause });
    return object;
  }

  get(type: string, id: string): StoredObject | undefined {
    return this.objects.get(type)?.get(id);
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

    const byId = this.objects.get(type);
    const ids = byId === undefined ? [] : [...byId.keys()].sort();
    const start =
      after === undefined ? 0 : ids.findIndex((id) => id > after);

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
    if (typeof objectOrListener === "function") {
      this.listeners.add(objectOrListener);
      return () => {
        this.listeners.delete(objectOrListener);
      };
    }
    if (factListener === undefined) {
      throw new Error("subscribe: a fact listener is required");
    }
    return this.subscribeFacts(objectOrListener, options, factListener);
  }

  subscribeFacts(
    object: ObjectRef,
    options: FactsOptions,
    listener: (fact: PluginFact) => void,
  ): () => void {
    const key = this.key(object.type, object.id);
    let after = this.factCursor(object, options.cursor);
    if (options.cursor === undefined) {
      const all = this.byObject.get(key) ?? [];
      after = all.at(-1)?.sequence ?? 0;
    }
    // Facts that arrived after the cursor but before the subscription are not
    // lost; deliver them now, then continue live.
    for (const fact of this.byObject.get(key) ?? []) {
      if (fact.sequence > after) listener(fact);
    }
    const subscription: FactSubscription = { key, after, listener };
    this.factListeners.add(subscription);
    return () => {
      this.factListeners.delete(subscription);
    };
  }

  append(input: StoreFactInput): PluginFact {
    requireName(input.type, "fact type");
    const cause = input.cause;
    requireName(cause, "cause");
    const fact: PluginFact = {
      sequence: this.entries.length + 1,
      type: input.type,
      object: input.object,
      cause,
      at: this.clock(),
      data: { ...input.data },
    };
    this.entries.push(fact);
    this.track(fact);
    if (fact.object !== undefined) {
      this.notify(fact.object);
    }
    return fact;
  }

  private assertWhere(type: string, options: ListOptions): void {
    if (options.where === undefined) return;
    const index = options.index ?? this.indexes.get(type);
    if (index === undefined) {
      // A type no plugin declared: everything it names is accepted.
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

  private track(fact: PluginFact): void {
    if (fact.object === undefined) return;
    const key = this.key(fact.object.type, fact.object.id);
    const list = this.byObject.get(key);
    if (list === undefined) this.byObject.set(key, [fact]);
    else list.push(fact);
    for (const subscription of this.factListeners) {
      if (subscription.key !== key) continue;
      if (fact.sequence <= subscription.after) continue;
      subscription.listener(fact);
    }
  }

  private key(type: string, id: string): string {
    return `${type}\u0000${id}`;
  }

  private notify(object: ObjectRef): void {
    for (const listener of this.listeners) listener(object);
  }
}
