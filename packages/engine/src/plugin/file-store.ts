/** A plugin store that keeps its facts in one append-only JSONL file. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { watchDirectory } from "../watch.ts";
import type {
  FactInput,
  ObjectData,
  ObjectRef,
  PluginFact,
  PluginStore,
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
  readonly kind = "file" as const;
  readonly root: string;
  private readonly clock: () => number;
  private readonly pollMs: number;
  private readonly repeat: (ms: number, callback: () => void) => () => void;
  private readonly watch: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
  private readonly factsPath: string;
  private readonly objects = new Map<string, StoredObject>();
  private readonly entries: PluginFact[] = [];
  private readonly listeners = new Set<(object: ObjectRef) => void>();
  /** Bytes of the facts file already read; a torn final line stays unread. */
  private offset = 0;
  /** Stops the directory watcher that reports another writer's facts. */
  private stopWatch: (() => void) | undefined;
  /** Stops the fallback check for a write the watch did not report. */
  private stopPoll: (() => void) | undefined;

  constructor(options: FilePluginStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
    this.pollMs = options.pollMs ?? DEFAULT_STORE_POLL_MS;
    this.repeat = options.repeat ?? repeatEvery;
    this.watch = options.watch ?? watchDirectory;
    this.factsPath = join(options.root, "facts.jsonl");
    mkdirSync(options.root, { recursive: true });
    this.refresh();
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
    this.append({ type, object: { type, id }, data, cause });
    return this.objects.get(this.key(type, id)) ?? object;
  }

  get(type: string, id: string): StoredObject | undefined {
    this.refresh();
    return this.objects.get(this.key(type, id));
  }

  list(type: string): readonly StoredObject[] {
    this.refresh();
    return [...this.objects.values()].filter((object) => object.type === type);
  }

  append(input: FactInput): PluginFact {
    requireName(input.type, "fact type");
    const cause = input.cause;
    if (cause === undefined) {
      throw new Error("cause: must be a non-empty string");
    }
    requireName(cause, "cause");
    this.refresh();
    const fact: PluginFact = {
      sequence: this.entries.length + 1,
      type: input.type,
      object: input.object,
      cause,
      at: this.clock(),
      data: { ...input.data },
    };
    appendFileSync(this.factsPath, `${JSON.stringify(fact)}\n`, "utf8");
    this.refresh();
    return fact;
  }

  /** Every fact in append order. */
  facts(): readonly PluginFact[] {
    this.refresh();
    return this.entries;
  }

  /** Tells a listener when an object gains a fact, including another writer's. */
  subscribe(listener: (object: ObjectRef) => void): () => void {
    this.listeners.add(listener);
    if (this.stopWatch === undefined) {
      this.stopWatch = this.watch(this.root, (filename) => {
        if (filename !== null && filename !== "facts.jsonl") return;
        this.refresh();
      });
      // A directory watch is the fast path, but it is not a promise: on macOS
      // a write can land with no event at all while the process is loaded.
      // This timer re-reads the file, so a listener cannot miss the write.
      this.stopPoll = this.repeat(this.pollMs, () => this.refresh());
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopWatch?.();
        this.stopWatch = undefined;
        this.stopPoll?.();
        this.stopPoll = undefined;
      }
    };
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
    for (const listener of this.listeners) listener(object);
  }

  private key(type: string, id: string): string {
    return `${type}\u0000${id}`;
  }
}
