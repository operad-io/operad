/** The trigger metadata a run needs: its event files and its pending start. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { StartInput } from "../kernel/types.ts";
import type { TriggerEvent, TriggerView } from "./types.ts";
import { isRecord } from "../util.ts";

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

/** The paths an event's summary and data files use inside the store. */
export interface EventFilePaths {
  readonly summary: string;
  readonly data: string;
}

/**
 * The files a run or a step reads. The log holds the event itself; this store
 * holds only material that cannot live in a JSON log: summary and data files,
 * a run's start metadata and the pending start of a run being created.
 */
export class TriggerStore {
  readonly root: string;
  private readonly clock: () => number;

  constructor(options: TriggerStoreOptions) {
    this.root = options.root;
    this.clock = options.clock ?? (() => Date.now());
    mkdirSync(options.root, { recursive: true });
  }

  eventPaths(inputId: string): EventFilePaths {
    const directory = join(this.root, "events", inputId);
    return {
      summary: join(directory, "summary.txt"),
      data: join(directory, "data.json"),
    };
  }

  /**
   * Writes the summary and data files of an event and returns the step-visible
   * view. An existing file is kept: the first event for an input wins, exactly
   * as the log's `recordInput` keeps the first payload.
   */
  writeEventFiles(inputId: string, event: TriggerEvent): TriggerView {
    const paths = this.eventPaths(inputId);
    if (event.summary !== undefined && !existsSync(paths.summary)) {
      mkdirSync(join(this.root, "events", inputId), { recursive: true });
      writeFileSync(paths.summary, event.summary, "utf8");
    }
    if (event.data !== undefined && !existsSync(paths.data)) {
      mkdirSync(join(this.root, "events", inputId), { recursive: true });
      writeFileSync(paths.data, `${JSON.stringify(event.data, null, 2)}\n`, "utf8");
    }
    return {
      source: event.source,
      key: event.key,
      type: event.type,
      ...(event.link === undefined ? {} : { link: event.link }),
      hops: event.hops,
      ...(event.summary === undefined ? {} : { summary: paths.summary }),
      ...(event.data === undefined ? {} : { data: paths.data }),
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
}
