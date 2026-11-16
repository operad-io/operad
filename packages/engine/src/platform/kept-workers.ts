/**
 * Kept workers: a harness child that may serve more than one reply stays in a
 * directory of its own home and records how another process reaches it.
 *
 * A kept worker has no run marker: the run that started it is over, and the
 * sweep for a step's left-over processes must leave it alone. The record here
 * is how `serve` and its clients tell a kept worker from an ordinary process,
 * find it for the next reply, end it when its owner asks, and never signal a
 * pid that has since been reused by another program. Only the owner may read
 * the directory or open the socket; both are created with owner-only
 * permissions.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { withLockFile } from "./file-lock.ts";
import { killProcessGroup, systemClock, type Clock } from "./process-group.ts";
import { readProcessTable } from "./step-reap.ts";

/** How long a worker is kept after a reply, when nobody asks for another. */
export const KEPT_WORKER_MS = 10 * 60 * 1000;

/** How many workers one home keeps. A fourth ends the one idle longest. */
export const MAX_KEPT_WORKERS = 3;

/** How long a kept worker may take to answer the first line of a new reply. */
export const KEPT_FIRST_LINE_MS = 5_000;

/** How long a kept worker gets to end after the stop request, before SIGKILL. */
export const KEPT_STOP_GRACE_MS = 500;

/** The command-line argument that names a kept worker's record. */
export const KEPT_WORKER_FLAG = "--operad-kept";

/** One kept worker as its owner records it. */
export interface KeptWorkerRecord {
  readonly pid: number;
  /** The random id that is also on the worker's command line. */
  readonly token: string;
  /** The chat (or other owner) the worker answers. */
  readonly scope: string;
  /** What the worker was started with; a different key means another worker. */
  readonly key: string;
  readonly socket: string;
  /** The record itself; filled in when the record is read. */
  readonly meta: string;
  readonly session: string | null;
  readonly startedAt: number;
  readonly lastUsedAt: number;
  /** True while the worker is answering a reply. */
  readonly busy?: boolean | undefined;
}

export interface KeptWorkerSlot {
  readonly dir: string;
  readonly token: string;
  readonly socket: string;
  readonly meta: string;
}

/** The directory a harness keeps its workers in. */
export function keptWorkerDirectory(home: string, name: string): string {
  return join(home, "harness", name, "kept");
}

function lockPath(home: string, name: string): string {
  return join(home, "harness", name, "kept.lock");
}

function ownerDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** A new socket and record path for a worker, with a token that is unique to it. */
export function newKeptWorkerSlot(home: string, name: string): KeptWorkerSlot {
  const dir = keptWorkerDirectory(home, name);
  ownerDirectory(dir);
  const token = randomBytes(8).toString("hex");
  return {
    dir,
    token,
    socket: join(dir, `${token}.sock`),
    meta: join(dir, `${token}.json`),
  };
}

/** The argument a kept worker carries, so a record's pid can be checked before it is signalled. */
export function keptWorkerArgument(token: string): string {
  return `${KEPT_WORKER_FLAG}=${token}`;
}

/** Writes a record whole: a reader sees the old one or the new one, never a half. */
export function writeKeptWorker(record: KeptWorkerRecord): void {
  ownerDirectory(dirname(record.meta));
  const temporary = `${record.meta}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, record.meta);
  chmodSync(record.meta, 0o600);
}

/** Removes a worker's record and socket; safe when they are already gone. */
export function removeKeptWorker(record: Pick<KeptWorkerRecord, "meta" | "socket">): void {
  rmSync(record.meta, { force: true });
  rmSync(record.socket, { force: true });
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordOf(path: string, value: unknown): KeptWorkerRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const pid = fields.pid;
  const token = textOf(fields.token);
  const scope = textOf(fields.scope);
  const key = textOf(fields.key);
  const socket = textOf(fields.socket);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return undefined;
  if (token === undefined || scope === undefined || key === undefined || socket === undefined) return undefined;
  const session = fields.session;
  const startedAt = fields.startedAt;
  const lastUsedAt = fields.lastUsedAt;
  return {
    pid,
    token,
    scope,
    key,
    socket,
    meta: path,
    session: typeof session === "string" ? session : null,
    startedAt: typeof startedAt === "number" ? startedAt : 0,
    lastUsedAt: typeof lastUsedAt === "number" ? lastUsedAt : 0,
    ...(fields.busy === true ? { busy: true } : {}),
  };
}

/** One record, or undefined when the file is missing, unreadable or not a record. */
export function readKeptWorker(path: string): KeptWorkerRecord | undefined {
  try {
    return recordOf(path, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A record another process is replacing, or one that is not ours.
    return undefined;
  }
}

/** Every record in one home's kept directory. A record that cannot be read is skipped. */
export function readKeptWorkers(home: string, name: string): readonly KeptWorkerRecord[] {
  const dir = keptWorkerDirectory(home, name);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: KeptWorkerRecord[] = [];
  for (const entry of names) {
    if (!entry.endsWith(".json")) continue;
    const record = readKeptWorker(join(dir, entry));
    if (record !== undefined) found.push(record);
  }
  return found;
}

/** Every kept worker of every harness in one home. */
export function readKeptWorkersInHome(home: string): readonly KeptWorkerRecord[] {
  const root = join(home, "harness");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.flatMap((name) => readKeptWorkers(home, name));
}

/** True when `pid` is still the kept worker named by `token`, not a reused pid. */
async function isWorkerProcess(pid: number, token: string): Promise<boolean> {
  const wanted = keptWorkerArgument(token);
  try {
    const rows = await readProcessTable();
    return rows.some((row) => row.pid === pid && row.command.includes(wanted));
  } catch {
    return false;
  }
}

/** Asks a worker to stop over its socket; true when it answered. */
function requestStop(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(socketPath);
    const finish = (stopped: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(stopped);
    };
    socket.setTimeout(Math.max(1, timeoutMs));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "stop" })}\n`);
      socket.end();
    });
    socket.once("close", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** Ends one kept worker: ask it over its socket, then signal only its own verified process. */
export async function stopKeptWorker(
  record: KeptWorkerRecord,
  options: { readonly clock?: Clock | undefined } = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  const answered = await requestStop(record.socket, KEPT_STOP_GRACE_MS);
  if (answered) {
    // Give the worker its grace to remove the record and leave.
    await clock.sleep(KEPT_STOP_GRACE_MS);
  }
  // A worker that answered may already be gone; a dead one never is signalled.
  if (await isWorkerProcess(record.pid, record.token)) {
    killProcessGroup(record.pid, "SIGTERM");
    await clock.sleep(KEPT_STOP_GRACE_MS);
    if (await isWorkerProcess(record.pid, record.token)) {
      killProcessGroup(record.pid, "SIGKILL");
    }
  }
  removeKeptWorker(record);
}

/** Filters a kept worker; every field that is given must match. */
export interface KeptWorkerFilter {
  readonly scope?: string | undefined;
  readonly key?: string | undefined;
  /** Keep these records, even when the other fields match. */
  readonly except?: (record: KeptWorkerRecord) => boolean | undefined;
}

/** Ends every kept worker of every harness in one home, oldest first. */
export async function stopAllKeptWorkers(options: {
  readonly home: string;
  readonly clock?: Clock | undefined;
}): Promise<readonly KeptWorkerRecord[]> {
  const root = join(options.home, "harness");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const ended: KeptWorkerRecord[] = [];
  for (const name of names) {
    if (readKeptWorkers(options.home, name).length === 0) continue;
    ended.push(...(await stopKeptWorkers({ home: options.home, name, clock: options.clock })));
  }
  return ended;
}

/** Ends the kept workers of one home that match `filter`, oldest first. */
export async function stopKeptWorkers(options: {
  readonly home: string;
  readonly name: string;
  readonly filter?: KeptWorkerFilter | undefined;
  readonly clock?: Clock | undefined;
}): Promise<readonly KeptWorkerRecord[]> {
  const filter = options.filter;
  return withLockFile(
    lockPath(options.home, options.name),
    async () => {
      const records = readKeptWorkers(options.home, options.name)
        .filter((record) => filter?.scope === undefined || record.scope === filter.scope)
        .filter((record) => filter?.key === undefined || record.key === filter.key)
        .filter((record) => filter?.except?.(record) !== true)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const record of records) await stopKeptWorker(record, { clock: options.clock });
      return records;
    },
    { label: `kept ${options.name}` },
  );
}
