/**
 * The model list `pi --list-models` prints, kept as a file under the operad
 * home. Reading it is synchronous, but asking pi never is: a stale list starts
 * one background refresh that concurrent readers share, and a reader that
 * needs a list before one exists can wait for that refresh.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, type HarnessModelCapability, type HarnessModelInfo } from "@operad-io/engine";
import { writeJsonAtomic } from "@operad-io/engine/platform";

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

/** One row of `pi --list-models`: the model's provider/id and what its columns say. */
export interface PiCatalogueRow {
  /** The provider/id a chat stores. */
  readonly name: string;
  /** A display name, when the table has a name column. */
  readonly displayName?: string | undefined;
  readonly provider?: string | undefined;
  readonly window?: number | undefined;
  readonly capabilities?: readonly HarnessModelCapability[] | undefined;
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

const CAPABILITY_COLUMNS: readonly [string, HarnessModelCapability][] = [
  ["thinking", "reasoning"],
  ["images", "vision"],
  ["tools", "tools"],
  ["web", "web"],
];

/** The rows of `pi --list-models`, with every column whose header names it. */
export function parsePiCatalogueModels(output: string): readonly PiCatalogueRow[] {
  const found: PiCatalogueRow[] = [];
  const names = new Set<string>();
  let header: readonly string[] | undefined;
  for (const line of output.split("\n")) {
    const cells = line.trim().split(/\s+/);
    const providerAt = cells.indexOf("provider");
    const modelAt = cells.indexOf("model");
    if (providerAt >= 0 && modelAt >= 0) {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (header === undefined) continue;
    const at = (name: string): number => header?.indexOf(name) ?? -1;
    const provider = cells[at("provider")] ?? cells[0];
    const id = cells[at("model")] ?? cells[1];
    if (provider === undefined || id === undefined || provider.length === 0 || id.length === 0) continue;
    const name = `${provider}/${id}`;
    if (names.has(name)) continue;
    names.add(name);
    const contextColumn = at("context");
    const window = parsePiTokenCount(contextColumn >= 0 ? cells[contextColumn] : cells[2]);
    const displayName = at("name") >= 0 ? cells[at("name")] : undefined;
    const capabilities: HarnessModelCapability[] = [];
    for (const [column, capability] of CAPABILITY_COLUMNS) {
      const value = at(column) >= 0 ? cells[at(column)]?.toLowerCase() : undefined;
      if (value === "yes" || value === "true" || value === "1") capabilities.push(capability);
    }
    found.push({
      name,
      ...(displayName === undefined || displayName.length === 0 ? {} : { displayName }),
      provider,
      ...(window === undefined ? {} : { window }),
      ...(capabilities.length === 0 ? {} : { capabilities }),
    });
  }
  return found;
}

/** The rows of `pi --list-models`: provider/id, and the context column when it is a token count. */
export function parsePiCatalogueRows(output: string): readonly PiCatalogueRow[] {
  return parsePiCatalogueModels(output).map((row) =>
    row.window === undefined ? { name: row.name } : { name: row.name, window: row.window },
  );
}

/**
 * The rows of `pi --list-models` as provider/id: the first two columns of each
 * row after the header row. Anything that is not such a row is skipped.
 */
export function parsePiCatalogue(output: string): readonly string[] {
  return parsePiCatalogueModels(output).map((row) => row.name);
}

/** What a file under the home holds: when it was read, the rows and their windows. */
interface KeptList {
  readonly at: number;
  readonly list: readonly string[];
  readonly windows?: Readonly<Record<string, number>> | undefined;
  readonly info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
}

/** Where the list comes from and what a refresh may use. */
export interface PiModelListOptions {
  readonly home: string;
  readonly command: string;
  readonly now: () => number;
  readonly timeoutMs?: number | undefined;
  readonly log?: ((message: string) => void) | undefined;
  /** pi's registry store, beside its models file; the display names come from it. */
  readonly registryPath?: string | undefined;
  /** Test seam: reads a file as text; defaults to `readFileSync(path, "utf8")`. */
  readonly readFile?: ((path: string) => string) | undefined;
}

interface KeptRead {
  readonly at: number;
  readonly list: readonly string[];
  readonly windows?: Readonly<Record<string, number>> | undefined;
  readonly info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
}

const MODEL_CAPABILITY_ORDER = ["vision", "reasoning", "tools", "web"] as const;

function readCapabilities(value: unknown): readonly HarnessModelCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const found: HarnessModelCapability[] = [];
  for (const item of value) {
    if (item === "vision" || item === "reasoning" || item === "tools" || item === "web") found.push(item);
  }
  return found.length === 0 ? undefined : found;
}

function readInfo(value: unknown): Readonly<Record<string, HarnessModelInfo>> | undefined {
  if (!isRecord(value)) return undefined;
  const info: Record<string, HarnessModelInfo> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const name = raw["name"];
    const provider = raw["provider"];
    const window = raw["window"];
    const capabilities = readCapabilities(raw["capabilities"]);
    info[id] = {
      id,
      ...(typeof name === "string" && name.length > 0 ? { name } : {}),
      ...(typeof provider === "string" && provider.length > 0 ? { provider } : {}),
      ...(typeof window === "number" && Number.isInteger(window) && window > 0 ? { window } : {}),
      ...(capabilities === undefined ? {} : { capabilities }),
    };
  }
  return Object.keys(info).length === 0 ? undefined : info;
}

/**
 * What pi's registry store says about each model, by provider/id. A model's
 * `name`, `reasoning` and its `input` list are the registry's own fields;
 * nothing is guessed when one is absent.
 */
export function parsePiRegistry(value: unknown): Readonly<Record<string, HarnessModelInfo>> {
  const info: Record<string, HarnessModelInfo> = {};
  const add = (providerId: string, raw: unknown): void => {
    if (!isRecord(raw)) return;
    const id = raw["id"];
    if (typeof id !== "string" || id.length === 0) return;
    const provider =
      typeof raw["provider"] === "string" && raw["provider"].length > 0 ? raw["provider"] : providerId;
    if (provider.length === 0) return;
    const name = raw["name"];
    const window = raw["contextWindow"];
    const capabilities: HarnessModelCapability[] = [];
    const input = raw["input"];
    if (Array.isArray(input) && input.includes("image")) capabilities.push("vision");
    if (raw["reasoning"] === true) capabilities.push("reasoning");
    const key = `${provider}/${id}`;
    info[key] = {
      id: key,
      ...(typeof name === "string" && name.length > 0 ? { name } : {}),
      provider,
      ...(typeof window === "number" && Number.isInteger(window) && window > 0 ? { window } : {}),
      ...(capabilities.length === 0 ? {} : { capabilities }),
    };
  };
  if (!isRecord(value)) return info;
  const providers = isRecord(value["providers"]) ? value["providers"] : value;
  for (const [providerId, raw] of Object.entries(providers)) {
    if (!isRecord(raw)) continue;
    const models = raw["models"];
    if (!Array.isArray(models)) continue;
    for (const model of models) add(providerId, model);
  }
  return info;
}

interface RegistryCache {
  readonly mtimeMs: number;
  readonly size: number;
  readonly info: Readonly<Record<string, HarnessModelInfo>>;
}

const registryCache = new Map<string, RegistryCache>();

function readText(options: PiModelListOptions, path: string): string {
  return (options.readFile ?? ((file: string) => readFileSync(file, "utf8")))(path);
}

function registryOf(options: PiModelListOptions): Readonly<Record<string, HarnessModelInfo>> {
  if (options.registryPath === undefined) return {};
  const path = options.registryPath;
  try {
    const stat = statSync(path);
    const kept = registryCache.get(path);
    if (kept !== undefined && kept.mtimeMs === stat.mtimeMs && kept.size === stat.size) {
      return kept.info;
    }
    const info = parsePiRegistry(JSON.parse(readText(options, path)));
    registryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    return info;
  } catch {
    registryCache.delete(path);
    return {};
  }
}

function mergeInfo(base: HarnessModelInfo | undefined, found: HarnessModelInfo): HarnessModelInfo {
  const capabilities = new Set<HarnessModelCapability>([
    ...(base?.capabilities ?? []),
    ...(found.capabilities ?? []),
  ]);
  return {
    id: found.id,
    ...(found.name !== undefined || base?.name !== undefined
      ? { name: found.name ?? base?.name }
      : {}),
    ...(found.provider !== undefined || base?.provider !== undefined
      ? { provider: found.provider ?? base?.provider }
      : {}),
    ...(found.window !== undefined || base?.window !== undefined
      ? { window: found.window ?? base?.window }
      : {}),
    ...(capabilities.size === 0
      ? {}
      : { capabilities: MODEL_CAPABILITY_ORDER.filter((capability) => capabilities.has(capability)) }),
  };
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
  const info = readInfo(value["info"]);
  return {
    at,
    list,
    ...(Object.keys(windows).length === 0 ? {} : { windows }),
    ...(info === undefined ? {} : { info }),
  };
}

/** The list the home keeps for this command, or undefined when there is none. */
export function readPiModelList(options: PiModelListOptions): KeptRead | undefined {
  try {
    const value: unknown = JSON.parse(readText(options, piModelListPath(options.home)));
    const kept = keptOf(value);
    return kept === undefined
      ? undefined
      : {
          at: kept.at,
          list: kept.list,
          ...(kept.windows === undefined ? {} : { windows: kept.windows }),
          ...(kept.info === undefined ? {} : { info: kept.info }),
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
    return parsePiCatalogueModels(out.trim() === "" ? err : out);
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
  const windows: Record<string, number> = {};
  const info: Record<string, HarnessModelInfo> = {};
  for (const row of rows) {
    if (row.window !== undefined) windows[row.name] = row.window;
    info[row.name] = {
      id: row.name,
      ...(row.displayName === undefined ? {} : { name: row.displayName }),
      ...(row.provider === undefined ? {} : { provider: row.provider }),
      ...(row.window === undefined ? {} : { window: row.window }),
      ...(row.capabilities === undefined ? {} : { capabilities: row.capabilities }),
    };
  }
  const kept: KeptList = {
    at,
    list: rows.map((row) => row.name),
    ...(Object.keys(windows).length === 0 ? {} : { windows }),
    ...(Object.keys(info).length === 0 ? {} : { info }),
  };
  await writeJsonAtomic(path, kept);
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
export function piModelList(
  options: PiModelListOptions,
  known: KeptRead | null = readPiModelList(options) ?? null,
): readonly string[] {
  if (known !== null && options.now() - known.at < PI_LIST_CACHE_MS) return known.list;
  void refreshPiModelList(options).catch(() => undefined);
  return known?.list ?? [];
}

/**
 * The kept list, waiting for one refresh only when there is none yet. A list
 * that exists is returned at once; an old one starts its refresh in the
 * background and the kept rows answer meanwhile.
 */
export async function piModelListReady(
  options: PiModelListOptions,
  known: KeptRead | null = readPiModelList(options) ?? null,
): Promise<readonly string[]> {
  if (known !== null) {
    if (options.now() - known.at >= PI_LIST_CACHE_MS) {
      void refreshPiModelList(options).catch(() => undefined);
    }
    return known.list;
  }
  return await refreshPiModelList(options);
}

/** The context windows of the kept model list, by provider/id; empty when none are kept. */
export function piModelWindows(
  options: PiModelListOptions,
  known: KeptRead | null = readPiModelList(options) ?? null,
): Readonly<Record<string, number>> {
  return known?.windows ?? {};
}

/**
 * What the kept model list and pi's registry say about each model, by
 * provider/id; the kept list wins where both know a field. Empty when neither
 * knows any model.
 */
export function piModelInfo(
  options: PiModelListOptions,
  known: KeptRead | null = readPiModelList(options) ?? null,
): Readonly<Record<string, HarnessModelInfo>> {
  const kept = known?.info ?? {};
  const registry = registryOf(options);
  const info: Record<string, HarnessModelInfo> = {};
  for (const [id, model] of Object.entries(registry)) info[id] = mergeInfo(undefined, model);
  for (const [id, model] of Object.entries(kept)) info[id] = mergeInfo(info[id], { ...model, id });
  return info;
}
