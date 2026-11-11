/**
 * Copies a home's store into a new store of the other kind, and switches the
 * configuration to it.
 *
 * The copy reads the source through its log and object-store interfaces and
 * writes the target through the other kind's interfaces. It keeps every run
 * id, sequence number, time, cause and payload: the writers take their times
 * and run ids from a queue the copy fills, and the copy checks every answer
 * against what it read.
 *
 * Only the files a store kind owns are copied:
 *
 * - jsonl: `runs/`, `inputs.jsonl`, `outcomes.jsonl`, `global-facts.jsonl`,
 *   `schema.json`, `.lock`, `plugins/facts.jsonl` and `plugins/facts.lock`;
 * - sqlite: `log.sqlite` and `plugins.sqlite` (with their `-wal` and `-shm`).
 *
 * Everything else under the store directory is a plain file both kinds keep
 * where it is, so the target shares it with the source and the paths recorded
 * in facts stay valid: `triggers/`, `logs/`, `plugins/logs/`, the plugins' own
 * directories under `plugins/`, and `locks/` (which only holds live locks).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StateError } from "../runner/errors.ts";
import { acquireLock, pidAlive, readLockPid, runLockPath, serveLockPath, storeMoveLockPath } from "../runner/lock.ts";
import { ConfigError, configPath, storeRootOf, type OperadConfig } from "../config/config.ts";
import { Database } from "bun:sqlite";
import { enableWal, setBusyTimeout, withFileLock } from "../platform/index.ts";
import { withFactsLock } from "../plugin/file-store.ts";
import { openJsonlLogBackend } from "../log/jsonl.ts";
import { openLog } from "../log/open-log.ts";
import { SQLITE_FILE_NAME } from "../log/sqlite.ts";
import type { Fact, InputRecord, JsonValue, LogBackend, NewFact, RunInfo } from "../log/types.ts";
import { openPluginStore } from "../plugin/open-store.ts";
import { SqlitePluginStore } from "../plugin/sqlite-store.ts";
import type { PluginFact, PluginStore } from "../plugin/types.ts";

export type StoreKind = "jsonl" | "sqlite";

/** How many facts one write carries. */
const BATCH = 500;
const PLUGIN_SQLITE_FILE = "plugins.sqlite";
const COPYING_DIRECTORY = ".copying-jsonl";
const COPYING_SQLITE = ".copying-sqlite";
const SIDECAR = ".store-copy.json";
const SNAPSHOT_DIRECTORY = ".copying-source";

export interface CopyStoreOptions {
  readonly home: string;
  readonly config: OperadConfig;
  /** The kind of the new store; the source is the one the config names. */
  readonly to: StoreKind;
  /** Called once the source has been read into the snapshot; tests write to the source here. */
  readonly afterSnapshot?: (() => void | Promise<void>) | undefined;
}

export interface CopyStoreResult {
  readonly from: StoreKind;
  readonly to: StoreKind;
  /** The `store.path` that selects the new store. */
  readonly path: string;
  readonly runs: number;
  readonly facts: number;
  readonly inputs: number;
  readonly outcomes: number;
  readonly globalFacts: number;
  readonly objectFacts: number;
}

/** The `store.path` a store of `kind` has under `root`. */
export function storePathFor(kind: StoreKind, root: string): string {
  return kind === "sqlite" ? join(root, SQLITE_FILE_NAME) : root;
}

/** The files a store of `kind` owns under `root`, as they would be named once copied. */
function ownedFiles(kind: StoreKind, root: string): string[] {
  return kind === "sqlite"
    ? [join(root, SQLITE_FILE_NAME), join(root, PLUGIN_SQLITE_FILE)]
    : [
        join(root, "schema.json"),
        join(root, "runs"),
        join(root, "inputs.jsonl"),
        join(root, "outcomes.jsonl"),
        join(root, "global-facts.jsonl"),
        join(root, "plugins", "facts.jsonl"),
      ];
}

/**
 * Refuses while a live process holds a run's lock. It only reads: a lock whose
 * process is gone is stale and does not block, and no file is removed.
 */
function assertNoRunHolds(root: string): void {
  const directory = join(root, "locks", "runs");
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".lock")) continue;
    const runId = name.slice(0, -".lock".length);
    const pid = readLockPid(runLockPath(root, runId));
    if (pid !== undefined && pidAlive(pid)) {
      throw new StateError(
        `run "${runId}" is in progress; wait for it to end before copying the store`,
      );
    }
  }
}

/**
 * Takes the home lock (so no serve starts) and then the store's move lock (so no
 * run starts), and only then looks for runs in progress. The move lock file is
 * the one thing written under the store, and it is removed with the `locks/`
 * directory when this made it.
 */
function holdStore(home: string, root: string): { release(): void } {
  const serve = acquireLock(serveLockPath(home));
  const hadLocks = existsSync(join(root, "locks"));
  let move: { release(): void } | undefined;
  try {
    move = acquireLock(storeMoveLockPath(root));
    assertNoRunHolds(root);
  } catch (error) {
    move?.release();
    serve.release();
    throw error;
  }
  return {
    release: () => {
      move?.release();
      if (!hadLocks) {
        try {
          rmdirSync(join(root, "locks"));
        } catch {
          // Something else made it meanwhile; leave it.
        }
      }
      serve.release();
    },
  };
}

/** A queue of the times the next writes must record. */
class TimeQueue {
  private readonly times: number[] = [];

  readonly clock = (): number => {
    const time = this.times.shift();
    if (time === undefined) throw new Error("the copy asked for a time it did not set");
    return time;
  };

  set(...times: number[]): void {
    this.times.length = 0;
    this.times.push(...times);
  }
}

function same(label: string, written: unknown, read: unknown): void {
  if (!isDeepStrictEqual(written, read)) {
    throw new Error(`the copy of ${label} does not match its source`);
  }
}

function pluginFactCopy(fact: PluginFact): {
  type: string;
  data: PluginFact["data"];
  cause: string;
  object?: PluginFact["object"];
} {
  return {
    type: fact.type,
    data: fact.data,
    cause: fact.cause,
    ...(fact.object === undefined ? {} : { object: fact.object }),
  };
}

/** Copies every run, input, outcome and global fact; `ids` hands each run id to the target. */
async function copyLog(source: LogBackend, target: LogBackend, times: TimeQueue, ids: string[]) {
  const counts = { runs: 0, facts: 0, inputs: 0, outcomes: 0, globalFacts: 0 };

  for await (const fact of source.readGlobal()) {
    times.set(fact.time);
    const written = await target.appendGlobal(
      { kind: fact.kind, payload: fact.payload, cause: fact.cause },
      fact.uniqueKey,
    );
    same(`global fact ${fact.seq}`, written, fact);
    counts.globalFacts += 1;
  }

  const inputs = new Map<string | null, InputRecord[]>();
  const allInputs = await readInputs(source);
  const totalInputs = allInputs.length;
  for (const input of allInputs) {
    const list = inputs.get(input.runId) ?? [];
    list.push(input);
    inputs.set(input.runId, list);
  }
  const recordInputs = async (runId: string | null): Promise<void> => {
    for (const input of inputs.get(runId) ?? []) {
      times.set(input.time);
      const written = await target.recordInput(runId, input.source, input.sourceKey, input.payload);
      if (written.duplicate || written.inputId !== input.inputId) {
        throw new Error(`the copy of input ${input.inputId} does not match its source`);
      }
      counts.inputs += 1;
    }
  };
  await recordInputs(null);

  // Oldest first, and each run whole before the next starts, so a flow and
  // object that ran twice never has two active runs in the target.
  const runs = [...(await source.runs())].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of runs) {
    ids.push(run.runId);
    times.set(run.startedAt);
    const started = await target.startRun(run.flow, run.object, run.startInputId, run.access);
    if (started.runId !== run.runId || started.startedAt !== run.startedAt) {
      throw new Error(`the copy of run ${run.runId} does not match its source`);
    }
    await recordInputs(run.runId);

    let lastSeq = 0;
    let batch: Fact[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      times.set(...batch.map((fact) => fact.time));
      const news: NewFact[] = batch.map(({ kind, payload, cause }) => ({ kind, payload, cause }));
      const written = await target.append(run.runId, lastSeq, news);
      same(`facts of run ${run.runId}`, written.facts, batch);
      lastSeq = written.lastSeq;
      counts.facts += batch.length;
      batch = [];
    };
    for await (const fact of source.read(run.runId)) {
      batch.push(fact);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    if (!run.active) {
      if (run.endedAt === null) throw new Error(`run ${run.runId} has no end time`);
      times.set(run.endedAt);
      await target.endRun(run.runId);
    }
    counts.runs += 1;
  }
  if (counts.inputs !== totalInputs) {
    throw new Error("an input belongs to a run that is not in the store");
  }
  const byRun = (a: RunInfo, b: RunInfo): number => (a.runId < b.runId ? -1 : 1);
  same("the runs", (await target.runs()).sort(byRun), (await source.runs()).sort(byRun));

  for await (const outcome of source.readOutcomes()) {
    times.set(outcome.time);
    const written = await target.recordOutcome(outcome.inputId, outcome.kind, outcome.payload);
    if (written.duplicate) throw new Error(`the copy of outcome ${outcome.seq} does not match its source`);
    same(`outcome ${outcome.seq}`, written.outcome, outcome);
    counts.outcomes += 1;
  }
  return counts;
}

async function readInputs(log: LogBackend): Promise<InputRecord[]> {
  const all: InputRecord[] = [];
  for await (const input of log.readInputs()) all.push(input);
  return all;
}

function copyObjects(source: PluginStore, target: PluginStore, now: { at: number }): number {
  const facts = source.facts();
  for (const fact of facts) {
    now.at = fact.at;
    // An object's new version is the fact whose type is the object's type; the
    // stores keep the object row from it, each in its own way.
    const written =
      fact.object !== undefined && fact.type === fact.object.type
        ? target.put(fact.object.type, fact.object.id, fact.data, fact.cause)
        : target.append(pluginFactCopy(fact));
    if (written instanceof Promise) throw new Error("the object store answered late");
  }
  same("the plugin objects", target.facts(), facts);
  return facts.length;
}

function closeObjects(store: PluginStore): void {
  if (store instanceof SqlitePluginStore) store.close();
}

/**
 * Tells whether another connection committed to a sqlite source since `mark`.
 * It keeps one read connection per database open, so the count it reads (the
 * database's data version) changes only by a commit from elsewhere, and not by
 * a checkpoint or a connection closing. A jsonl source has nothing to watch.
 */
function watchSqlite(
  config: OperadConfig,
  root: string,
): { mark(): void; changed(): boolean; close(): void } {
  const files =
    config.store.backend === "sqlite" ? [config.store.path, join(root, PLUGIN_SQLITE_FILE)] : [];
  const open: Array<{ database: Database; version: number }> = [];
  const version = (database: Database): number =>
    (database.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  return {
    mark() {
      for (const file of files) {
        if (!existsSync(file)) continue;
        const database = new Database(file, { readonly: true });
        setBusyTimeout(database);
        open.push({ database, version: version(database) });
      }
    },
    changed() {
      return open.some((entry) => version(entry.database) !== entry.version);
    },
    close() {
      for (const entry of open.splice(0)) entry.database.close();
    },
  };
}

/**
 * What the source's own files look like: path, size and modification time of
 * every file the copy reads. A write to the source while it is copied changes
 * this. It only reads.
 */
function fingerprint(config: OperadConfig, root: string): string {
  // A sqlite source is watched by `watchSqlite`: its file sizes and times also
  // move when a connection closes and folds the write-ahead file in, which is
  // not a write.
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  if (config.store.backend === "jsonl") {
    walk(join(root, "runs"));
    for (const name of ["inputs.jsonl", "outcomes.jsonl", "global-facts.jsonl", "schema.json"]) {
      files.push(join(root, name));
    }
    files.push(join(root, "plugins", "facts.jsonl"));
  }
  return files
    .map((path) => {
      try {
        const info = statSync(path);
        return `${path} ${info.size} ${info.mtimeMs}`;
      } catch {
        return `${path} none`;
      }
    })
    .join("\n");
}

/** Runs `fn` while holding the locks the source's writers take, so no write is half done. */
function withWriters<T>(config: OperadConfig, root: string, fn: () => T): T {
  const holders: Array<(inner: () => T) => T> = [];
  if (config.store.backend === "jsonl") {
    // A store that has none of these files has had no writer.
    if (existsSync(join(root, ".lock"))) holders.push((inner) => withFileLock(join(root, ".lock"), inner));
    if (existsSync(join(root, "plugins"))) {
      holders.push((inner) => withFactsLock(join(root, "plugins", "facts.lock"), inner));
    }
  } else {
    for (const file of [config.store.path, join(root, PLUGIN_SQLITE_FILE)]) {
      if (!existsSync(file)) continue;
      holders.push((inner) => {
        const database = new Database(file, { readwrite: true });
        try {
          setBusyTimeout(database);
          enableWal(database);
          return database.transaction(inner).immediate();
        } finally {
          database.close();
        }
      });
    }
  }
  return holders.reduceRight<() => T>((inner, hold) => () => hold(inner), fn)();
}

/** A summary of what the source holds, to tell later whether it moved on. */
async function marksOf(log: LogBackend, objects: PluginStore): Promise<string> {
  const runs = (await log.runs()).map((run) => `${run.runId}:${run.lastSeq}:${run.endedAt}`).sort();
  let globals = 0;
  for await (const fact of log.readGlobal()) globals = fact.seq;
  let inputs = 0;
  for await (const input of log.readInputs()) inputs += input.inputId.length > 0 ? 1 : 0;
  let outcomes = 0;
  for await (const outcome of log.readOutcomes()) outcomes = outcome.seq;
  const facts = objects.facts();
  return JSON.stringify({ runs, globals, inputs, outcomes, objects: facts.at(-1)?.sequence ?? 0, count: facts.length });
}

/** Copies the files of the source store that the copy reads; returns the log's path in the snapshot. */
function snapshotSource(config: OperadConfig, root: string, snapshot: string): string {
  mkdirSync(snapshot, { recursive: true });
  const take = (from: string, to: string): void => {
    if (existsSync(from)) cpSync(from, to, { recursive: true });
  };
  if (config.store.backend === "jsonl") {
    for (const name of ["runs", "inputs.jsonl", "outcomes.jsonl", "global-facts.jsonl", "schema.json"]) {
      take(join(root, name), join(snapshot, name));
    }
    mkdirSync(join(snapshot, "plugins"), { recursive: true });
    take(join(root, "plugins", "facts.jsonl"), join(snapshot, "plugins", "facts.jsonl"));
    return snapshot;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    take(`${config.store.path}${suffix}`, join(snapshot, `${SQLITE_FILE_NAME}${suffix}`));
    take(join(root, `${PLUGIN_SQLITE_FILE}${suffix}`), join(snapshot, `${PLUGIN_SQLITE_FILE}${suffix}`));
  }
  return join(snapshot, SQLITE_FILE_NAME);
}

/**
 * Copies the store the config names into a new store of kind `to`, beside it
 * under the same store directory. Refuses while the home's serve or a run
 * holds the store, and when the new store's files already exist. The source is
 * not changed. The new store appears all at once: a copy that fails leaves
 * nothing behind.
 */
export async function copyStore(options: CopyStoreOptions): Promise<CopyStoreResult> {
  const { home, config, to } = options;
  const from = config.store.backend;
  if (from === to) {
    throw new StateError(`the store already uses ${to}`);
  }
  const root = storeRootOf(config);

  // The home lock is the one serve takes first, so no serve starts while this
  // runs; a running serve or command makes this throw before anything is read.
  const lock = holdStore(home, root);
  try {
    for (const file of ownedFiles(to, root)) {
      if (existsSync(file)) {
        throw new StateError(
          `${file} already exists; move or remove the ${to} store there before copying`,
        );
      }
    }
    // A copy that was killed leaves only these; nothing else reads them.
    const temporary = {
      // Their own directory, so the writers' move check (which looks beside the
      // file) does not refuse the copy's own writes.
      log: join(root, COPYING_SQLITE, SQLITE_FILE_NAME),
      plugins: join(root, COPYING_SQLITE, PLUGIN_SQLITE_FILE),
      directory: join(root, COPYING_DIRECTORY),
      snapshot: join(root, SNAPSHOT_DIRECTORY),
    };
    const clean = (): void => {
      rmSync(join(root, COPYING_SQLITE), { recursive: true, force: true });
      rmSync(temporary.directory, { recursive: true, force: true });
      rmSync(temporary.snapshot, { recursive: true, force: true });
    };
    clean();

    const times = new TimeQueue();
    const objectTime = { at: 0 };
    const ids: string[] = [];
    const nextId = (): string => {
      const id = ids.pop();
      if (id === undefined) throw new Error("the copy asked for a run it did not set");
      return id;
    };

    // Opening a store repairs and creates things (a torn last line is cut, an
    // old schema marker is rewritten, a missing directory is made). Nothing of
    // the source is opened in place: everything the copy reads is copied into
    // a snapshot first, and only the snapshot is opened.
    // The snapshot is taken while holding every lock a writer of the source
    // takes: a write already under way finishes first and is in the snapshot,
    // and a write that starts later finds the move lock and is refused.
    let seen = "";
    const watch = watchSqlite(config, root);
    let sourceLog: string;
    try {
      sourceLog = withWriters(config, root, () => {
        seen = fingerprint(config, root);
        watch.mark();
        return snapshotSource(config, root, temporary.snapshot);
      });
    } catch (error) {
      watch.close();
      throw error;
    }
    await options.afterSnapshot?.();
    const source = openLog({ backend: from, path: sourceLog });
    const sourceObjects = openPluginStore({ backend: from, root: temporary.snapshot });
    let target: LogBackend | undefined;
    let targetObjects: PluginStore | undefined;
    try {
      if (to === "sqlite") {
        target = openLog({
          backend: "sqlite",
          path: temporary.log,
          clock: times.clock,
          runId: nextId,
        });
        targetObjects = new SqlitePluginStore({
          root,
          file: temporary.plugins,
          clock: () => objectTime.at,
        });
      } else {
        mkdirSync(temporary.directory, { recursive: true });
        target = openJsonlLogBackend(temporary.directory, { clock: times.clock, runId: nextId });
        targetObjects = openPluginStore({
          backend: "jsonl",
          root: temporary.directory,
          clock: () => objectTime.at,
        });
      }

      const marks = await marksOf(source, sourceObjects);
      const counts = await copyLog(source, target, times, ids);
      const objectFacts = copyObjects(sourceObjects, targetObjects, objectTime);
      // A write that reached the source after it was read is not in the copy;
      // switching to the copy would lose it.
      if (fingerprint(config, root) !== seen || watch.changed()) {
        throw new StateError(
          "the store changed while it was being copied; nothing was switched, try again when nothing is writing to it",
        );
      }
      await target.close();
      target = undefined;
      closeObjects(targetObjects);
      targetObjects = undefined;

      // What the source held, so `use` can tell whether it moved on since.
      writeFileSync(join(root, SIDECAR), `${JSON.stringify({ to, marks })}\n`);

      // Move into place; the file `use` and every open look for comes last.
      if (to === "sqlite") {
        renameSync(temporary.plugins, join(root, PLUGIN_SQLITE_FILE));
        renameSync(temporary.log, join(root, SQLITE_FILE_NAME));
      } else {
        mkdirSync(join(root, "plugins"), { recursive: true });
        renameSync(
          join(temporary.directory, "plugins", "facts.jsonl"),
          join(root, "plugins", "facts.jsonl"),
        );
        for (const name of ["runs", "inputs.jsonl", "outcomes.jsonl", "global-facts.jsonl", ".lock"]) {
          if (existsSync(join(temporary.directory, name))) {
            renameSync(join(temporary.directory, name), join(root, name));
          }
        }
        renameSync(join(temporary.directory, "schema.json"), join(root, "schema.json"));
      }
      return { from, to, path: storePathFor(to, root), ...counts, objectFacts };
    } finally {
      watch.close();
      await target?.close();
      if (targetObjects !== undefined) closeObjects(targetObjects);
      closeObjects(sourceObjects);
      await source.close();
      clean();
    }
  } finally {
    lock.release();
  }
}

/**
 * A copy made by `copyStore` records what its source held. Switching to it
 * while the source holds something else would lose what was written since.
 * Switching back to a store this command did not just make is not checked.
 */
async function assertCopyCurrent(config: OperadConfig, root: string, kind: StoreKind): Promise<void> {
  const sidecar = join(root, SIDECAR);
  if (!existsSync(sidecar)) return;
  let recorded: { to?: unknown; marks?: unknown };
  try {
    recorded = JSON.parse(readFileSync(sidecar, "utf8")) as { to?: unknown; marks?: unknown };
  } catch {
    return;
  }
  if (recorded.to !== kind) return;
  const snapshot = join(root, SNAPSHOT_DIRECTORY);
  rmSync(snapshot, { recursive: true, force: true });
  try {
    const path = withWriters(config, root, () => snapshotSource(config, root, snapshot));
    const log = openLog({ backend: config.store.backend, path });
    const objects = openPluginStore({ backend: config.store.backend, root: snapshot });
    try {
      if ((await marksOf(log, objects)) !== recorded.marks) {
        const files = ownedFiles(kind, root)
          .map((file) => file.slice(root.length + 1))
          .join(", ");
        throw new StateError(
          `the store changed after it was copied; remove ${files} and run \`operad store copy ${kind}\` again`,
        );
      }
    } finally {
      closeObjects(objects);
      await log.close();
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * Points the configuration at the store `copyStore` made. Refuses while serve
 * runs, and when there is no such store beside the current one.
 */
export async function useStore(home: string, config: OperadConfig, kind: StoreKind): Promise<string> {
  if (config.store.backend === kind) {
    throw new StateError(`the store already uses ${kind}`);
  }
  const root = storeRootOf(config);
  const lock = holdStore(home, root);
  try {
    const marker = kind === "sqlite" ? join(root, SQLITE_FILE_NAME) : join(root, "schema.json");
    if (!existsSync(marker)) {
      throw new StateError(`there is no ${kind} store beside this one; copy it first`);
    }
    await assertCopyCurrent(config, root, kind);
    const file = configPath(home);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      throw new ConfigError(`${file}: cannot be read: ${String(error)}`, { cause: error });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigError(`${file}: must be a JSON object`);
    }
    const path = storePathFor(kind, root);
    const store: Record<string, JsonValue> = { backend: kind, path };
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ...raw, store }, null, 2)}\n`);
    await rename(temp, file);
    return path;
  } finally {
    lock.release();
  }
}
