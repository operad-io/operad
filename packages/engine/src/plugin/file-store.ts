/** A plugin store that keeps its facts in one append-only JSONL file. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FactInput,
  ObjectData,
  PluginFact,
  PluginStore,
  StoredObject,
} from "./types.ts";

export interface FilePluginStoreOptions {
  readonly root: string;
  readonly clock?: (() => number) | undefined;
}

function requireName(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field}: must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  readonly root: string;
  private readonly clock: () => number;
  private readonly factsPath: string;
  private readonly objects = new Map<string, StoredObject>();
  private readonly entries: PluginFact[] = [];

  constructor(options: FilePluginStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
    this.factsPath = join(options.root, "facts.jsonl");
    mkdirSync(options.root, { recursive: true });
    this.load();
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

    const previous = this.objects.get(this.key(type, id));
    const object: StoredObject = {
      type,
      id,
      data: { ...data },
      version: (previous?.version ?? 0) + 1,
      cause,
      at: this.clock(),
    };
    this.objects.set(this.key(type, id), object);
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
    appendFileSync(this.factsPath, `${JSON.stringify(fact)}\n`, "utf8");
    return fact;
  }

  /** Every fact in append order. */
  facts(): readonly PluginFact[] {
    return this.entries;
  }

  private load(): void {
    if (!existsSync(this.factsPath)) return;
    const text = readFileSync(this.factsPath, "utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // A torn final line from a killed writer is not a fact.
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
    if (object === undefined || fact.type !== object.type) return;
    const previous = this.objects.get(this.key(object.type, object.id));
    this.objects.set(this.key(object.type, object.id), {
      type: object.type,
      id: object.id,
      data: { ...fact.data },
      version: (previous?.version ?? 0) + 1,
      cause: fact.cause,
      at: fact.at,
    });
  }

  private key(type: string, id: string): string {
    return `${type}\u0000${id}`;
  }
}
