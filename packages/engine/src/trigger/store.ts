/** The event journal: what each source sent, and what the kernel did with it. */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../log/types.ts";
import type { StartInput } from "../kernel/types.ts";
import type {
  TriggerCandidate,
  TriggerEvent,
  TriggerResult,
  TriggerView,
} from "./types.ts";

export type CandidateStatus = "pending" | "started" | "dismissed";

/** A result as stored: the view fields plus what a candidate needs later. */
export interface StoredTriggerResult extends TriggerResult {
  readonly params?: JsonValue;
  readonly status?: CandidateStatus;
  readonly at: number;
}

/** A recorded event that no routing outcome has claimed yet. */
export interface UnroutedEvent {
  readonly inputId: string;
  readonly event: TriggerEvent;
}

/**
 * A start whose run metadata may not be written yet. It is written before the
 * run exists, so a process that dies between `startRun` and the run's own
 * start files loses nothing: whoever finds the idle run adopts this record.
 */
export interface PendingStart {
  readonly id: string;
  readonly flow: string;
  readonly object: string;
  readonly at: number;
  readonly inputId?: string;
  readonly start: StartInput;
  readonly view?: TriggerView;
}

interface StoredRecord {
  readonly type: "event" | "result";
  readonly inputId: string;
  readonly at: number;
  readonly event?: TriggerEvent;
  readonly result?: StoredTriggerResult;
}

/** Reads a run's start metadata without opening a store. */
export function readStoredStart(
  storeRoot: string,
  runId: string,
): StartInput | undefined {
  const path = join(storeRoot, "triggers", "runs", runId, "start.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value) || value.kind !== "start") return undefined;
    return value as unknown as StartInput;
  } catch {
    return undefined;
  }
}

/** Reads a run's trigger view without opening a store. */
export function readStoredTrigger(
  storeRoot: string,
  runId: string,
): TriggerView | undefined {
  const path = join(storeRoot, "triggers", "runs", runId, "trigger.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value)) return undefined;
    if (
      typeof value.source !== "string" ||
      typeof value.key !== "string" ||
      typeof value.type !== "string" ||
      typeof value.hops !== "number"
    ) {
      return undefined;
    }
    return value as unknown as TriggerView;
  } catch {
    return undefined;
  }
}

export interface TriggerStoreOptions {
  readonly root: string;
  readonly clock?: (() => number) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): StoredRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "event" && value.type !== "result") return undefined;
  if (typeof value.inputId !== "string") return undefined;
  if (typeof value.at !== "number") return undefined;
  if (value.type === "event") {
    if (!isRecord(value.event)) return undefined;
    return value as unknown as StoredRecord;
  }
  if (!isRecord(value.result)) return undefined;
  return value as unknown as StoredRecord;
}

/**
 * Keeps events and their results in one append-only file under the store. A
 * duplicated `source`+`key` is already refused by the log's input store; this
 * journal remembers what the first one did so a second call can report it.
 */
export class TriggerStore {
  readonly root: string;
  private readonly clock: () => number;
  private readonly path: string;
  private readonly events = new Map<string, TriggerEvent>();
  private readonly results = new Map<string, StoredTriggerResult>();
  private offset = 0;

  constructor(options: TriggerStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
    this.path = join(options.root, "events.jsonl");
    mkdirSync(options.root, { recursive: true });
    this.refresh();
  }

  /** Writes the event and returns it, without deciding anything. */
  recordEvent(inputId: string, event: TriggerEvent): void {
    this.refresh();
    const record: StoredRecord = {
      type: "event",
      inputId,
      event,
      at: this.clock(),
    };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.events.set(inputId, event);
  }

  setResult(inputId: string, result: Omit<StoredTriggerResult, "at">): void {
    this.refresh();
    const stored: StoredTriggerResult = { ...result, at: this.clock() };
    const record: StoredRecord = {
      type: "result",
      inputId,
      result: stored,
      at: stored.at,
    };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.results.set(inputId, stored);
  }

  event(inputId: string): TriggerEvent | undefined {
    this.refresh();
    return this.events.get(inputId);
  }

  result(inputId: string): StoredTriggerResult | undefined {
    this.refresh();
    return this.results.get(inputId);
  }

  /** Events the journal recorded that have no result yet. */
  unrouted(): readonly UnroutedEvent[] {
    this.refresh();
    const list: UnroutedEvent[] = [];
    for (const [inputId, event] of this.events) {
      if (this.results.has(inputId)) continue;
      list.push({ inputId, event });
    }
    return list;
  }

  /** The latest status of a candidate, by its pending id. */
  candidate(pendingId: string): TriggerCandidate | undefined {
    this.refresh();
    for (const [inputId, result] of this.results) {
      if (result.kind !== "candidate" || result.pendingId !== pendingId) continue;
      const event = this.events.get(inputId);
      if (event === undefined || result.flow === undefined || result.object === undefined) {
        continue;
      }
      return {
        pendingId,
        inputId,
        flow: result.flow,
        ...(result.params === undefined ? {} : { params: result.params }),
        object: result.object,
        event,
        status: result.status ?? "pending",
        ...(result.runId === undefined ? {} : { runId: result.runId }),
        at: result.at,
      };
    }
    return undefined;
  }

  /** Candidates that are still waiting for a person, oldest first. */
  candidates(): readonly TriggerCandidate[] {
    this.refresh();
    const list: TriggerCandidate[] = [];
    for (const [inputId, result] of this.results) {
      if (result.kind !== "candidate") continue;
      if ((result.status ?? "pending") !== "pending") continue;
      const event = this.events.get(inputId);
      if (event === undefined || result.flow === undefined || result.object === undefined) {
        continue;
      }
      list.push({
        pendingId: result.pendingId ?? inputId,
        inputId,
        flow: result.flow,
        ...(result.params === undefined ? {} : { params: result.params }),
        object: result.object,
        event,
        status: "pending",
        at: result.at,
      });
    }
    return list.sort((left, right) => left.at - right.at);
  }

  /** Writes summary and data under the store and returns the step-visible view. */
  writeEventFiles(inputId: string, event: TriggerEvent): TriggerView {
    const directory = join(this.root, "events", inputId);
    let summary: string | undefined;
    let data: string | undefined;
    if (event.summary !== undefined) {
      mkdirSync(directory, { recursive: true });
      summary = join(directory, "summary.txt");
      writeFileSync(summary, event.summary, "utf8");
    }
    if (event.data !== undefined) {
      mkdirSync(directory, { recursive: true });
      data = join(directory, "data.json");
      writeFileSync(data, `${JSON.stringify(event.data, null, 2)}\n`, "utf8");
    }
    return {
      source: event.source,
      key: event.key,
      type: event.type,
      ...(event.link === undefined ? {} : { link: event.link }),
      hops: event.hops,
      ...(summary === undefined ? {} : { summary }),
      ...(data === undefined ? {} : { data }),
    };
  }

  /**
   * Writes a start before the run exists and returns its id. The caller drops
   * it once the run's own `start.json` and `trigger.json` are written.
   */
  writePendingStart(
    record: Omit<PendingStart, "id" | "at">,
  ): string {
    const id = randomUUID();
    const pending: PendingStart = { ...record, id, at: this.clock() };
    const directory = join(this.root, "pending");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${id}.json`),
      `${JSON.stringify(pending)}\n`,
      "utf8",
    );
    return id;
  }

  /**
   * The pending start for a flow and object. A record written no later than
   * `notAfter`, the run's own start time, wins, so an attempt that never made
   * a run cannot be mistaken for the one that did. Under a clock skew between
   * the store and the log the newest record is still the best answer.
   */
  pendingStart(
    flow: string,
    object: string,
    notAfter?: number,
  ): PendingStart | undefined {
    const directory = join(this.root, "pending");
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch {
      return undefined;
    }
    let before: PendingStart | undefined;
    let latest: PendingStart | undefined;
    for (const name of names.sort()) {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(join(directory, name), "utf8"));
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      if (typeof value.id !== "string") continue;
      if (value.flow !== flow || value.object !== object) continue;
      if (typeof value.at !== "number") continue;
      if (!isRecord(value.start) || value.start.kind !== "start") continue;
      const pending = value as unknown as PendingStart;
      if (latest === undefined || pending.at >= latest.at) latest = pending;
      if (notAfter !== undefined && pending.at > notAfter) continue;
      if (before === undefined || pending.at >= before.at) before = pending;
    }
    return before ?? latest;
  }

  dropPendingStart(id: string): void {
    rmSync(join(this.root, "pending", `${id}.json`), { force: true });
  }

  /** Persist a run's trigger view so a recovered step sees the same files. */
  writeRunTrigger(runId: string, view: TriggerView): void {
    const directory = join(this.root, "runs", runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "trigger.json"), `${JSON.stringify(view)}\n`, "utf8");
  }

  readRunTrigger(runId: string): TriggerView | undefined {
    const path = join(this.root, "runs", runId, "trigger.json");
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(value)) return undefined;
      if (
        typeof value.source !== "string" ||
        typeof value.key !== "string" ||
        typeof value.type !== "string" ||
        typeof value.hops !== "number"
      ) {
        return undefined;
      }
      return value as unknown as TriggerView;
    } catch {
      return undefined;
    }
  }

  writeRunStart(runId: string, start: unknown): void {
    const directory = join(this.root, "runs", runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "start.json"), `${JSON.stringify(start)}\n`, "utf8");
  }

  readRunStart(runId: string): unknown {
    const path = join(this.root, "runs", runId, "start.json");
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  private refresh(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size <= this.offset) return;
    const text = readFileSync(this.path).subarray(this.offset).toString("utf8");
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
        continue;
      }
      const record = parseRecord(raw);
      if (record === undefined) continue;
      if (record.type === "event" && record.event !== undefined) {
        this.events.set(record.inputId, record.event);
      } else if (record.type === "result" && record.result !== undefined) {
        this.results.set(record.inputId, record.result);
      }
    }
  }
}
