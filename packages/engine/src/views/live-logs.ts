/**
 * Watches the log files of active runs for growth the fact log never sees.
 *
 * A step writes its lines to a file under `<store>/logs/<plugin>/runs/<run>/`.
 * That write touches no database, so the run log records no fact for it and a
 * client that re-reads a section only on an event would not see the unfinished
 * content grow. This watcher announces the run's object when a file in its run
 * directory changes. It only learns that a file changed: it never reads the
 * file and never writes.
 *
 * The watch is the fast path; a timer checks the files' size and time as the
 * fallback, so a write the platform does not report still arrives. Both the
 * watch and the timer come from the platform helpers, as the run log's own
 * watcher does.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LogBackend } from "../log/types.ts";
import { runLogDirectory } from "../plugin/logger.ts";
import { messageOf } from "../plugin/errors.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { ObjectRef, PluginStore, StoredObject } from "../plugin/types.ts";
import { isRecord, parseObjectId } from "../util.ts";

/** One file's fingerprint: enough to tell that it changed, never its text. */
type FileStamp = string;

/** The directories watched for one run, and what each file looked like last. */
interface WatchedRun {
  readonly runId: string;
  readonly object: ObjectRef;
  readonly stops: Map<string, () => void>;
  readonly files: Map<string, Map<string, FileStamp>>;
}

export interface LiveLogWatchOptions {
  /** The store root the plugins write their logs under. */
  readonly storeRoot: string;
  readonly registry: PluginRegistry;
  readonly store: PluginStore;
  readonly log: LogBackend;
  /** The platform's directory watch; the owner resolves it from its options. */
  readonly watch: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
  /** The platform's repeating timer, the fallback for a write no watch reports. */
  readonly repeat: (ms: number, callback: () => void) => () => void;
  readonly pollMs: number;
  /** Announces that an object's live content grew. */
  readonly onGrowth: (object: ObjectRef) => void;
  readonly onLog?: ((message: string) => void) | undefined;
}

/** Whether `path` is a directory now. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The fingerprint of one file, or undefined when it is gone or unreadable. */
function stampOf(path: string): FileStamp | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Every file in a run directory and its fingerprint, by name. */
function snapshotOf(directory: string): Map<string, FileStamp> {
  const files = new Map<string, FileStamp>();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return files;
  }
  for (const name of names) {
    const stamp = stampOf(join(directory, name));
    if (stamp !== undefined) files.set(name, stamp);
  }
  return files;
}

/** Whether two directory snapshots differ in a file's presence or fingerprint. */
function snapshotsDiffer(
  before: Map<string, FileStamp>,
  after: Map<string, FileStamp>,
): boolean {
  if (before.size !== after.size) return true;
  for (const [name, stamp] of after) {
    if (before.get(name) !== stamp) return true;
  }
  return false;
}

/**
 * Watches the step logs of every active run whose object has a live section,
 * and tells its owner when one of those logs grows. A run with no log
 * directory yet is picked up on the next check, once the directory exists.
 */
export class LiveLogWatch {
  private readonly options: LiveLogWatchOptions;
  private readonly runs = new Map<string, WatchedRun>();
  private readonly stopRepeat: () => void;
  private syncing: Promise<void> | undefined;
  private again = false;
  private closed = false;

  constructor(options: LiveLogWatchOptions) {
    this.options = options;
    this.stopRepeat = options.repeat(options.pollMs, () => this.tick());
    void this.sync();
  }

  /**
   * Re-reads the active runs and retries the directories that did not exist
   * yet. The views call it whenever the run log says something changed; the
   * repeating timer calls it too, so a run is found without one.
   */
  sync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const running = this.syncing;
    if (running !== undefined) {
      // A change that arrives while a refresh runs is looked at once more.
      this.again = true;
      return running;
    }
    const work = this.refresh().finally(() => {
      this.syncing = undefined;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    this.syncing = work;
    return work;
  }

  /** Stops every watch and timer this watcher opened. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRepeat();
    for (const runId of [...this.runs.keys()]) this.forget(runId);
  }

  private tick(): void {
    void this.sync().then(() => this.poll());
  }

  /** Adds the active runs that are not watched and drops the ones that ended. */
  private async refresh(): Promise<void> {
    if (this.closed) return;
    let active: readonly { readonly runId: string; readonly object: string }[];
    try {
      active = await this.options.log.runs({ active: true });
    } catch (error) {
      this.options.onLog?.(
        `could not read the active runs for watching their logs: ${messageOf(error)}`,
      );
      return;
    }
    if (this.closed) return;
    const seen = new Set<string>();
    for (const run of active) {
      const parsed = parseObjectId(run.object);
      if (parsed === undefined) continue;
      if (!(await this.hasLiveSection(parsed.type, parsed.id))) continue;
      seen.add(run.runId);
      if (this.runs.has(run.runId)) continue;
      this.runs.set(run.runId, {
        runId: run.runId,
        object: parsed,
        stops: new Map(),
        files: new Map(),
      });
    }
    for (const runId of [...this.runs.keys()]) {
      if (!seen.has(runId)) this.forget(runId);
    }
    if (this.closed) return;
    for (const watched of this.runs.values()) this.ensureDirectories(watched);
  }

  /** Whether any of the object's sections says its content still grows. */
  private async hasLiveSection(type: string, id: string): Promise<boolean> {
    const views = this.options.registry.viewsFor(type)?.views;
    if (views === undefined) return false;
    let object: StoredObject | undefined;
    try {
      object = await this.options.store.get(type, id);
    } catch {
      return false;
    }
    if (object === undefined) return false;
    let sections: unknown;
    try {
      sections = views.sections(object);
    } catch {
      return false;
    }
    if (!Array.isArray(sections)) return false;
    return sections.some((entry) => isRecord(entry) && entry.live === true);
  }

  /** Watches every loaded plugin's directory for this run that exists now. */
  private ensureDirectories(watched: WatchedRun): void {
    const wanted = new Set(
      this.options.registry
        .names()
        .map((plugin) =>
          runLogDirectory(this.options.storeRoot, plugin, watched.runId),
        ),
    );
    for (const directory of new Set([
      ...watched.stops.keys(),
      ...watched.files.keys(),
    ])) {
      if (wanted.has(directory)) continue;
      this.stopDirectory(watched, directory);
    }
    for (const directory of wanted) {
      if (watched.stops.has(directory)) continue;
      const before = watched.files.get(directory);
      if (!isDirectory(directory)) {
        // An empty baseline: the first line a directory that is not there yet
        // receives is growth, even when it lands before the watch is opened.
        watched.files.set(directory, new Map());
        continue;
      }
      // The snapshot is taken before the watch opens, so a write between the
      // two is found by the fallback check instead of entering the baseline.
      const after = snapshotOf(directory);
      const stop = this.options.watch(directory, (filename) =>
        this.grew(watched, directory, filename),
      );
      watched.stops.set(directory, stop);
      watched.files.set(directory, after);
      // A directory the run start already had is not growth: that start
      // announced the object. One that appeared later may hold lines no event
      // has announced yet, so its first content is announced now.
      if (before !== undefined && snapshotsDiffer(before, after)) {
        this.options.onGrowth(watched.object);
      }
    }
  }

  /**
   * One directory watch fired. The file it names is remembered by its
   * fingerprint, so the fallback check does not announce the same write again.
   */
  private grew(
    watched: WatchedRun,
    directory: string,
    filename: string | null,
  ): void {
    if (this.closed) return;
    if (this.runs.get(watched.runId) !== watched) return;
    const files = watched.files.get(directory) ?? new Map<string, FileStamp>();
    if (filename === null) {
      watched.files.set(directory, snapshotOf(directory));
    } else {
      const path = join(directory, filename);
      const stamp = stampOf(path);
      if (stamp === undefined) files.delete(filename);
      else files.set(filename, stamp);
      watched.files.set(directory, files);
    }
    this.options.onGrowth(watched.object);
  }

  /**
   * The fallback check: a file whose size or time changed since the last look
   * is growth the platform did not report.
   */
  private poll(): void {
    if (this.closed) return;
    for (const watched of this.runs.values()) {
      let grew = false;
      for (const directory of watched.stops.keys()) {
        const before = watched.files.get(directory) ?? new Map<string, FileStamp>();
        const after = snapshotOf(directory);
        watched.files.set(directory, after);
        if (snapshotsDiffer(before, after)) grew = true;
      }
      if (grew) this.options.onGrowth(watched.object);
    }
  }

  /** Stops watching one run and forgets it. */
  private forget(runId: string): void {
    const watched = this.runs.get(runId);
    if (watched === undefined) return;
    for (const directory of [...watched.stops.keys()]) {
      this.stopDirectory(watched, directory);
    }
    this.runs.delete(runId);
  }

  private stopDirectory(watched: WatchedRun, directory: string): void {
    watched.stops.get(directory)?.();
    watched.stops.delete(directory);
    watched.files.delete(directory);
  }
}
