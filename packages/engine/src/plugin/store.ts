import type {
  FactInput,
  ObjectData,
  PluginFact,
  PluginStore,
  StoredObject,
} from "./types.ts";

/** Options for the in-process store used before the storage backends land. */
export interface MemoryPluginStoreOptions {
  readonly root: string;
  /** The clock facts use. Tests inject one. */
  readonly clock?: (() => number) | undefined;
}

function requireName(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field}: must be a non-empty string`);
  }
}

/**
 * The store the kernel gives plugins before a storage backend is chosen. Each
 * object change and each appended fact is kept in order; `facts()` is the
 * history the kernel's views will read.
 */
export class MemoryPluginStore implements PluginStore {
  readonly kind = "memory" as const;
  readonly root: string;
  private readonly clock: () => number;
  private readonly objects = new Map<string, StoredObject>();
  private readonly entries: PluginFact[] = [];

  constructor(options: MemoryPluginStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
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

    const key = this.key(type, id);
    const previous = this.objects.get(key);
    const object: StoredObject = {
      type,
      id,
      data: { ...data },
      version: (previous?.version ?? 0) + 1,
      cause,
      at: this.clock(),
    };
    this.objects.set(key, object);
    this.append({ type, object: { type, id }, data, cause });
    return object;
  }

  get(type: string, id: string): StoredObject | undefined {
    return this.objects.get(this.key(type, id));
  }

  list(type: string): readonly StoredObject[] {
    return [...this.objects.values()].filter((object) => object.type === type);
  }

  append(input: FactInput): PluginFact {
    requireName(input.type, "fact type");
    const cause = input.cause;
    if (cause === undefined) {
      throw new Error("cause: must be a non-empty string");
    }
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
    return fact;
  }

  /** Every fact in append order. The kernel's history view reads this. */
  facts(): readonly PluginFact[] {
    return this.entries;
  }

  private key(type: string, id: string): string {
    return `${type}\u0000${id}`;
  }
}
