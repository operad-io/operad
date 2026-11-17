/**
 * The user's own Codex: found, never bundled (ADR 0022 D6, D8). `inspectCodex`
 * is what `operad plugin check` runs: it asks the configured command for its
 * help (which proves the app-server exists), reads `codex --version`, refuses
 * a Codex older than the protocol this client was built against, and reads
 * `codex login status`. Credentials are the user's own Codex login; operad
 * never reads or writes them.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HarnessModels } from "@operad-io/engine";

/** How long one probe may take. */
const PROBE_TIMEOUT_MS = 30_000;

/** How long the app-server inside the model probe has to answer `model/list`. */
const MODELS_PROBE_TIMEOUT_MS = 8_000;

/** How long `codex login status` may take when a client asks for the login state. */
export const SIGNED_IN_PROBE_TIMEOUT_MS = 10_000;

/** How long a non-empty model list from the app-server is kept. */
export const MODELS_CACHE_MS = 30_000;

/**
 * How soon an empty model list is tried again. An empty answer is not kept for
 * `MODELS_CACHE_MS`: a Codex that was missing or busy at the last read gets
 * another chance soon.
 */
export const MODELS_EMPTY_RETRY_MS = 2_000;

/** The probe that speaks enough app-server to read the model list. */
const MODELS_PROBE = fileURLToPath(new URL("./models-probe.ts", import.meta.url));

/**
 * The oldest Codex this client was built against. The protocol was read from
 * codex-cli 0.166.0; an older Codex may not have the app-server at all, or may
 * speak a different shape of it.
 */
export const CODEX_FLOOR = "0.166.0";

/** The check could not pass; the message says what to do. */
export class CodexInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexInstallError";
  }
}

/**
 * The command that starts the user's app-server when the `command` setting is
 * unset: the `codex` of PATH with `app-server`. Codex's script has a
 * `#!/usr/bin/env node` shebang, which finds a node only in a shell that set
 * one up (fnm), so a script is run by the `bun` of PATH, or by this bun.
 */
export function defaultCommand(path: string | undefined = process.env.PATH): readonly string[] {
  const bun = Bun.which("bun", { PATH: path ?? "" }) ?? process.execPath;
  const codex = codexCommand(bun, path);
  if (codex === undefined) {
    throw new CodexInstallError(
      "no `codex` was found on PATH; install Codex (https://developers.openai.com/codex) or set the command setting",
    );
  }
  return [...codex, "app-server"];
}

/** The argv of the `command` setting, or the default one. */
export function commandOf(setting: unknown, path: string | undefined = process.env.PATH): readonly string[] {
  if (setting === undefined) return defaultCommand(path);
  if (!Array.isArray(setting) || setting.length === 0 || !setting.every((word) => typeof word === "string" && word.length > 0)) {
    throw new CodexInstallError("settings.command: must be a non-empty list of strings: the program and its arguments");
  }
  return setting.filter((word): word is string => typeof word === "string");
}

interface Ran {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(argv: readonly string[], args: readonly string[]): Ran {
  try {
    const ran = Bun.spawnSync([...argv, ...args], {
      stdin: "ignore",
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: PROBE_TIMEOUT_MS,
    });
    return {
      exitCode: ran.exitCode,
      stdout: ran.stdout.toString("utf8"),
      stderr: ran.stderr.toString("utf8"),
    };
  } catch {
    return { exitCode: null, stdout: "", stderr: "" };
  }
}

/** The Codex command: its script run by bun when its shebang names node. */
export function codexCommand(bun: string, path: string | undefined = process.env.PATH): readonly string[] | undefined {
  const found = Bun.which("codex", { PATH: path ?? "" });
  if (found === null) return undefined;
  const real = realpathSync(found);
  try {
    const head = readFileSync(real, "utf8").slice(0, 120).split("\n")[0] ?? "";
    if (head.startsWith("#!") && head.includes("node")) return [bun, real];
  } catch {
    // A native binary is not text.
  }
  return [real];
}

/** The last word-like token of a version line: `codex-cli 0.166.0` gives `0.166.0`. */
function versionOf(stdout: string): string | undefined {
  const line = stdout.split("\n").find((text) => text.trim().length > 0)?.trim();
  if (line === undefined) return undefined;
  const found = /\d+\.\d+\.\d+\S*/.exec(line);
  return found?.[0];
}

function versionParts(version: string): readonly [number, number, number] | undefined {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (found === null) return undefined;
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** Whether `version` is at least `floor`; an unreadable version is not compared. */
export function versionAtLeast(version: string, floor: string): boolean {
  const left = versionParts(version);
  const right = versionParts(floor);
  if (left === undefined || right === undefined) return true;
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The login kind from `codex login status`: only the kind, never an account or a key. */
function loginKind(stdout: string): string {
  const found = /^Logged in using ([A-Za-z0-9 ]{1,30}?)(?:\s+-|\s*$)/m.exec(stdout.trim());
  return found?.[1] ?? "unknown login";
}

/**
 * Whether the user's Codex is signed in, from `codex login status`: true on a
 * zero exit, false on a non-zero one, undefined when codex is absent or cannot
 * be asked. It never blocks the event loop and reads no account detail.
 */
export async function codexSignedIn(codex: readonly string[] | undefined): Promise<boolean | undefined> {
  if (codex === undefined) return undefined;
  const signal = AbortSignal.timeout(SIGNED_IN_PROBE_TIMEOUT_MS);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...codex, "login", "status"], {
      stdin: "ignore",
      env: { ...process.env },
      stdout: "ignore",
      stderr: "ignore",
      signal,
    });
  } catch {
    return undefined;
  }
  try {
    const exitCode = await child.exited;
    if (signal.aborted || exitCode === null) return undefined;
    return exitCode === 0;
  } catch {
    return undefined;
  }
}

/** What `operad plugin check` learns about the install. */
export interface CodexInstall {
  readonly codexVersion: string | undefined;
  /** The login kind, such as `ChatGPT`; undefined when Codex could not be asked. */
  readonly login: string | undefined;
}

/**
 * Proves the configured command has an app-server, reads the installed Codex
 * version, refuses one older than `CODEX_FLOOR`, and asks the login kind.
 * Throws `CodexInstallError` with what to do when the app-server cannot start,
 * Codex is too old, or Codex is not logged in. A Codex that cannot be asked is
 * reported as unknown.
 */
export function inspectCodex(command: readonly string[], codex: readonly string[] | undefined): CodexInstall {
  const help = run(command, ["--help"]);
  if (help.exitCode !== 0) {
    throw new CodexInstallError(
      `\`${command.join(" ")} --help\` did not run; the installed Codex has no app-server ` +
        `(this harness was built against codex-cli ${CODEX_FLOOR}); upgrade Codex or set the command setting`,
    );
  }
  if (codex === undefined) return { codexVersion: undefined, login: undefined };
  const version = run(codex, ["--version"]);
  const codexVersion = version.exitCode === 0 ? versionOf(version.stdout) : undefined;
  if (codexVersion !== undefined && !versionAtLeast(codexVersion, CODEX_FLOOR)) {
    throw new CodexInstallError(
      `Codex ${codexVersion} is too old; this harness needs codex-cli ${CODEX_FLOOR} or newer ` +
        `(its app-server protocol was read from ${CODEX_FLOOR})`,
    );
  }
  const status = run(codex, ["login", "status"]);
  if (status.exitCode === null) return { codexVersion, login: undefined };
  if (status.exitCode !== 0) {
    throw new CodexInstallError("Codex is not logged in; run `codex login` first");
  }
  // `codex login status` writes its line to stderr, not stdout.
  return { codexVersion, login: loginKind(`${status.stdout}${status.stderr}`) };
}

interface ModelsCache {
  readonly at: number;
  readonly value: HarnessModels;
}

const modelsCache = new Map<string, ModelsCache>();
const modelsLoading = new Map<string, Promise<HarnessModels>>();

/** What a probe of the app-server's model list prints: id, whether it is the default, and any window. */
interface ModelChoice {
  readonly id: string;
  readonly isDefault: boolean;
  readonly contextWindow?: number | undefined;
}

function emptyModels(): HarnessModels {
  return { list: [], default: null };
}

function parseModels(stdout: string): readonly ModelChoice[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const choices: ModelChoice[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    if (typeof id === "string" && id.length > 0) {
      const window = record["contextWindow"] ?? record["modelContextWindow"];
      choices.push({
        id,
        isDefault: record["isDefault"] === true,
        ...(typeof window === "number" && Number.isInteger(window) && window > 0
          ? { contextWindow: window }
          : {}),
      });
    }
  }
  return choices;
}

/** Asks a short-lived app-server for its model list; empty when it cannot answer. */
async function probeModels(command: readonly string[], timeoutMs: number): Promise<HarnessModels> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([process.execPath, MODELS_PROBE, "--timeout-ms", String(timeoutMs), ...command], {
      stdin: "ignore",
      env: { ...process.env },
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return emptyModels();
  }
  // The backstop is above the probe's own timeout: it answers by then.
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs + PROBE_TIMEOUT_MS);
  try {
    const stream = child.stdout;
    if (!(stream instanceof ReadableStream)) {
      await child.exited;
      return emptyModels();
    }
    const [stdout, exitCode] = await Promise.all([
      new Response(stream).text(),
      child.exited,
    ]);
    if (exitCode !== 0) return emptyModels();
    const choices = parseModels(stdout);
    const list = choices.map((choice) => choice.id);
    const fallback = choices.find((choice) => choice.isDefault)?.id ?? list[0] ?? null;
    const windows: Record<string, number> = {};
    for (const choice of choices) {
      if (choice.contextWindow !== undefined) windows[choice.id] = choice.contextWindow;
    }
    return {
      list,
      default: fallback,
      ...(Object.keys(windows).length === 0 ? {} : { windows }),
    };
  } catch {
    return emptyModels();
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/**
 * Refreshes the `model` choices from the app-server's own `model/list` (the
 * same list the user's Codex shows). The read is asynchronous so a slow or
 * missing Codex never holds up `serve`; concurrent reads share one probe.
 */
export function refreshCodexModels(
  command: readonly string[],
  at: number = Date.now(),
  timeoutMs: number = MODELS_PROBE_TIMEOUT_MS,
): Promise<HarnessModels> {
  const key = command.join("\u0000");
  const pending = modelsLoading.get(key);
  if (pending !== undefined) return pending;
  const loading = probeModels(command, timeoutMs)
    .then((value) => {
      modelsCache.set(key, { at, value });
      return value;
    })
    .finally(() => {
      modelsLoading.delete(key);
    });
  modelsLoading.set(key, loading);
  return loading;
}

function fresh(kept: ModelsCache, now: number): boolean {
  const ttl = kept.value.list.length === 0 ? MODELS_EMPTY_RETRY_MS : MODELS_CACHE_MS;
  return now - kept.at < ttl;
}

/**
 * The `model` choices a chat may pick, from the cache. A missing or stale cache
 * is refreshed in the background; this call returns the last answer (or none)
 * at once, so it never blocks the event loop.
 */
export function codexModels(command: readonly string[], now: number = Date.now()): HarnessModels {
  const key = command.join("\u0000");
  const kept = modelsCache.get(key);
  if (kept !== undefined && fresh(kept, now)) return kept.value;
  void refreshCodexModels(command, now).catch(() => undefined);
  return kept?.value ?? emptyModels();
}
