/**
 * The model list `pi --list-models` prints, kept as a file under the operad
 * home. Reading it is synchronous, but asking pi never is: a stale list starts
 * one background refresh that concurrent readers share, and a reader that
 * needs a list before one exists can wait for that refresh.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How long `pi --list-models` may take before pi counts as not answering. */
export const PI_LIST_TIMEOUT_MS = 10_000;

/** How old the kept list may get before a read starts a background refresh. */
export const PI_LIST_CACHE_MS = 10 * 60_000;

/** How soon a failed refresh is tried again. */
export const PI_LIST_RETRY_MS = 60_000;

const MODEL_LIST_FILE = "model-list.json";

/** The file under the operad home that keeps pi's model list. */
export function piModelListPath(home: string): string {
  return join(home, "harness", "pi", MODEL_LIST_FILE);
}

/** One row of `pi --list-models`: the model's provider/id and its context window when the table gives one. */
export interface PiCatalogueRow {
  readonly name: string;
  readonly window?: number | undefined;
}

/** A human token count from pi's table (`400K`, `1M`, `1.5M`) as a whole number. */
export function parsePiTokenCount(value: string | undefined): number | undefined {
  const found = value === undefined ? null : /^(\d+(?:\.\d+)?)([KM])?$/i.exec(value);
  if (found === null) return undefined;
  const count = Number(found[1]);
  const unit = found[2]?.toUpperCase();
  if (!Number.isFinite(count) || count <= 0) return undefined;
  const tokens = unit === "M" ? count * 1_000_000 : unit === "K" ? count * 1_000 : count;
  return Math.round(tokens);
}

/** The rows of `pi --list-models`: provider/id, and the context column when it is a token count. */
export function parsePiCatalogueRows(output: string): readonly PiCatalogueRow[] {
  const found: PiCatalogueRow[] = [];
  const names = new Set<string>();
  let header = false;
  for (const line of output.split("\n")) {
    const [provider, id, context] = line.trim().split(/\s+/);
    if (provider === undefined || id === undefined) continue;
    // Rows count only after the header; a status sentence has none.
    if (provider === "provider" && id === "model") {
      header = true;
      continue;
    }
    if (!header) continue;
    const name = `${provider}/${id}`;
    if (names.has(name)) continue;
    names.add(name);
    const window = parsePiTokenCount(context);
    found.push(window === undefined ? { name } : { name, window });
  }
  return found;
}

/**
 * The rows of `pi --list-models` as provider/id: the first two columns of each
 * row after the header row. Anything that is not such a row is skipped.
 */
export function parsePiCatalogue(output: string): readonly string[] {
  return parsePiCatalogueRows(output).map((row) => row.name);
}

/** What a file under the home holds: when it was read, the rows and their windows. */
interface KeptList {
  readonly at: number;
  readonly list: readonly string[];
  readonly windows?: Readonly<Record<string, number>> | undefined;
}

/** Where the list comes from and what a refresh may use. */
export interface PiModelListOptions {
  readonly home: string;
  readonly command: string;
  readonly now: () => number;
  readonly timeoutMs?: number | undefined;
  readonly log?: ((message: string) => void) | undefined;
}

interface KeptRead {
  readonly at: number;
  readonly list: readonly string[];
  readonly windows?: Readonly<Record<string, number>> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keptOf(value: unknown): KeptList | undefined {
  if (!isRecord(value)) return undefined;
  const at = value["at"];
  const list = value["list"];
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
  if (!Array.isArray(list)) return undefined;
  if (!list.every((item): item is string => typeof item === "string")) return undefined;
  const windows: Record<string, number> = {};
  const raw = value["windows"];
  if (isRecord(raw)) {
    for (const [name, window] of Object.entries(raw)) {
      if (typeof window === "number" && Number.isInteger(window) && window > 0) windows[name] = window;
    }
  }
  return {
    at,
    list,
    ...(Object.keys(windows).length === 0 ? {} : { windows }),
  };
}

/** The list the home keeps for this command, or undefined when there is none. */
export function readPiModelList(options: PiModelListOptions): KeptRead | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(piModelListPath(options.home), "utf8"));
    const kept = keptOf(value);
    return kept === undefined
      ? undefined
      : {
          at: kept.at,
          list: kept.list,
          ...(kept.windows === undefined ? {} : { windows: kept.windows }),
        };
  } catch {
    return undefined;
  }
}

const refreshing = new Map<string, Promise<readonly string[]>>();
const failedAt = new Map<string, number>();
const failedLogged = new Set<string>();

function keyOf(options: PiModelListOptions): string {
  return `${options.home}\u0000${options.command}`;
}

function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}

async function textOf(stream: unknown): Promise<string> {
  return stream instanceof ReadableStream ? await new Response(stream).text() : "";
}

/** Asks pi once. Undefined means it failed, was killed, or answered with an error. */
async function probe(options: PiModelListOptions): Promise<readonly PiCatalogueRow[] | undefined> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([options.command, "--list-models"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return undefined;
  }
  // A refresh from a short command must not keep that command alive.
  child.unref();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? PI_LIST_TIMEOUT_MS);
  unref(timer);
  try {
    const [out, err, exitCode] = await Promise.all([
      textOf(child.stdout),
      textOf(child.stderr),
      child.exited,
    ]);
    if (timedOut || exitCode !== 0) return undefined;
    return parsePiCatalogueRows(out.trim() === "" ? err : out);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function writeKept(
  options: PiModelListOptions,
  rows: readonly PiCatalogueRow[],
  at: number,
): Promise<void> {
  const path = piModelListPath(options.home);
  const temporary = join(dirname(path), `.${MODEL_LIST_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  const windows: Record<string, number> = {};
  for (const row of rows) {
    if (row.window !== undefined) windows[row.name] = row.window;
  }
  const kept: KeptList = {
    at,
    list: rows.map((row) => row.name),
    ...(Object.keys(windows).length === 0 ? {} : { windows }),
  };
  await writeFile(temporary, `${JSON.stringify(kept)}\n`);
  await rename(temporary, path);
}

/**
 * Asks pi for its list in the background. Concurrent callers share one ask; a
 * failed or timed-out ask keeps the previous file and is not tried again until
 * `PI_LIST_RETRY_MS` passes. It is logged once until an ask succeeds.
 */
export function refreshPiModelList(options: PiModelListOptions): Promise<readonly string[]> {
  const key = keyOf(options);
  const pending = refreshing.get(key);
  if (pending !== undefined) return pending;
  const failed = failedAt.get(key);
  if (failed !== undefined && options.now() - failed < PI_LIST_RETRY_MS) {
    return Promise.resolve(readPiModelList(options)?.list ?? []);
  }
  const loading = probe(options)
    .then(async (rows) => {
      if (rows === undefined) {
        failedAt.set(key, options.now());
        if (!failedLogged.has(key)) {
          failedLogged.add(key);
          options.log?.(
            `pi: \`${options.command} --list-models\` did not answer; the kept model list is used until a later refresh`,
          );
        }
        return readPiModelList(options)?.list ?? [];
      }
      failedAt.delete(key);
      failedLogged.delete(key);
      const at = options.now();
      await writeKept(options, rows, at).catch(() => undefined);
      return rows.map((row) => row.name);
    })
    .finally(() => {
      refreshing.delete(key);
    });
  refreshing.set(key, loading);
  return loading;
}

/**
 * The kept list, starting a background refresh when it is old enough. This
 * never waits for pi: a missing list is empty and a refresh fills it later.
 */
export function piModelList(options: PiModelListOptions): readonly string[] {
  const kept = readPiModelList(options);
  if (kept !== undefined && options.now() - kept.at < PI_LIST_CACHE_MS) return kept.list;
  void refreshPiModelList(options).catch(() => undefined);
  return kept?.list ?? [];
}

/**
 * The kept list, waiting for one refresh only when there is none yet. A list
 * that exists is returned at once; an old one starts its refresh in the
 * background and the kept rows answer meanwhile.
 */
export async function piModelListReady(options: PiModelListOptions): Promise<readonly string[]> {
  const kept = readPiModelList(options);
  if (kept !== undefined) {
    if (options.now() - kept.at >= PI_LIST_CACHE_MS) {
      void refreshPiModelList(options).catch(() => undefined);
    }
    return kept.list;
  }
  return await refreshPiModelList(options);
}

/** The context windows of the kept model list, by provider/id; empty when none are kept. */
export function piModelWindows(options: PiModelListOptions): Readonly<Record<string, number>> {
  return readPiModelList(options)?.windows ?? {};
}
