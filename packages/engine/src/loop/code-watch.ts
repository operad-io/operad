/**
 * The code a process loaded, as a fingerprint, and a watch on it.
 *
 * A process keeps running the code it loaded. `serve` and every run's process
 * record a fingerprint of the files they loaded (the engine and cli sources, each
 * loaded plugin's package and the workspace packages it depends on, their
 * schemas) and compare it later: `serve` watches and restarts itself, a run's
 * process compares between steps and hands over.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, watchDirectory } from "../platform/index.ts";
import type { Clock } from "../platform/index.ts";
import { messageOf } from "../plugin/errors.ts";

/** A file or directory whose files count as code, under the name a log line uses. */
export interface CodeRoot {
  readonly label: string;
  readonly path: string;
}

/** The files of the code roots and a hash of each file's content. */
export interface CodeFingerprint {
  readonly hashes: ReadonlyMap<string, string>;
  readonly labels: ReadonlyMap<string, string>;
  /** The directories that hold the files, for watching. */
  readonly directories: ReadonlySet<string>;
}

/** The files that differ between two fingerprints, by root label. */
export interface CodeChange {
  readonly labels: readonly string[];
  readonly files: readonly string[];
}

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "test",
  "tests",
  "fixtures",
]);

/** Docs and tests are not code a process loads. */
function isCodeFile(name: string): boolean {
  return !name.endsWith(".md") && !name.endsWith(".test.ts");
}

/**
 * Remembers a file's hash under its size and timestamps. A hash read while
 * the stamps were still fresh stays untrusted: Linux rounds a newly written
 * file's timestamps to the millisecond, so a same-size rewrite can keep the
 * key, and a later poll must read the file again before it believes the hash.
 */
export interface HashCache {
  readonly entries: Map<
    string,
    { readonly key: string; readonly hash: string; readonly trusted: boolean }
  >;
  readonly now: () => number;
}

export function newHashCache(now: () => number = Date.now): HashCache {
  return { entries: new Map(), now };
}

/** How close a stamp may be to now before a cached hash stops being trusted. */
const RACY_MS = 2_000;

function hashFile(path: string, cache: HashCache): string | undefined {
  try {
    const info = statSync(path);
    const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = cache.entries.get(path);
    if (cached?.key === key && cached.trusted) return cached.hash;
    const hash = Bun.hash(readFileSync(path)).toString(16);
    const trusted = cache.now() - Math.max(info.mtimeMs, info.ctimeMs) > RACY_MS;
    cache.entries.set(path, { key, hash, trusted });
    return hash;
  } catch {
    return undefined;
  }
}

/** Reads the files of every root. A missing file or directory counts as empty. */
export function fingerprintCode(
  roots: readonly CodeRoot[],
  cache: HashCache = newHashCache(),
): CodeFingerprint {
  const hashes = new Map<string, string>();
  const labels = new Map<string, string>();
  const directories = new Set<string>();

  const visit = (label: string, path: string, top: boolean): void => {
    let info;
    try {
      info = statSync(path);
    } catch {
      directories.add(dirname(path));
      return;
    }
    if (info.isDirectory()) {
      directories.add(path);
      let names: string[];
      try {
        names = readdirSync(path).sort();
      } catch {
        return;
      }
      for (const name of names) {
        const child = join(path, name);
        let childInfo;
        try {
          childInfo = statSync(child);
        } catch {
          continue;
        }
        if (childInfo.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(name) && !name.startsWith(".")) {
            visit(label, child, false);
          }
        } else if (isCodeFile(name)) {
          visit(label, child, false);
        }
      }
      return;
    }
    if (!top && !isCodeFile(path)) return;
    directories.add(dirname(path));
    const hash = hashFile(path, cache);
    if (hash === undefined || hashes.has(path)) return;
    hashes.set(path, hash);
    labels.set(path, label);
  };

  for (const root of roots) visit(root.label, root.path, true);
  return { hashes, labels, directories };
}

/** What differs between two fingerprints; undefined when nothing does. */
export function diffFingerprints(
  before: CodeFingerprint,
  after: CodeFingerprint,
): CodeChange | undefined {
  const files: string[] = [];
  const labels = new Set<string>();
  for (const [file, hash] of after.hashes) {
    if (before.hashes.get(file) !== hash) {
      files.push(file);
      labels.add(after.labels.get(file) ?? file);
    }
  }
  for (const file of before.hashes.keys()) {
    if (!after.hashes.has(file)) {
      files.push(file);
      labels.add(before.labels.get(file) ?? file);
    }
  }
  if (files.length === 0) return undefined;
  return { labels: [...labels].sort(), files: files.sort() };
}

/** One line for a log or for history: what changed, by name. */
export function describeChange(change: CodeChange): string {
  const shown = change.files.slice(0, 3).map((file) => file.split("/").slice(-2).join("/"));
  const more = change.files.length > shown.length ? ` and ${change.files.length - shown.length} more` : "";
  return `${change.labels.join(", ")}: ${shown.join(", ")}${more}`;
}

function packageDirectoryOf(file: string): string | undefined {
  let directory = dirname(file);
  for (;;) {
    try {
      statSync(join(directory, "package.json"));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
}

/** The directory of the engine package, which every process loads. */
export const ENGINE_CODE_ROOT: CodeRoot = {
  label: "engine",
  path: fileURLToPath(new URL("../../", import.meta.url)),
};

/** The file a plugin specifier names, resolved the way the loader does. */
export function pluginFile(specifier: string, home: string): string | undefined {
  try {
    if (specifier.startsWith("file:")) return realpathSync(fileURLToPath(specifier));
    if (specifier.startsWith("~")) {
      return realpathSync(join(homedir(), specifier.slice(1)));
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return realpathSync(resolve(home, specifier));
    }
    // The loader imports a bare module name from inside the engine package,
    // not from the operad home: resolve it from there.
    return realpathSync(Bun.resolveSync(specifier, ENGINE_CODE_ROOT.path));
  } catch {
    return undefined;
  }
}

/** The workspace packages a package directory lists as dependencies. */
function workspaceDependencies(directory: string): string[] {
  const found: string[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const dependencies =
      typeof raw === "object" && raw !== null && "dependencies" in raw
        ? (raw as { dependencies?: unknown }).dependencies
        : undefined;
    if (typeof dependencies !== "object" || dependencies === null) return found;
    for (const name of Object.keys(dependencies)) {
      if (!name.startsWith("@operad-io/")) continue;
      try {
        found.push(dirname(realpathSync(Bun.resolveSync(`${name}/package.json`, directory))));
      } catch {
        // A dependency that does not resolve adds nothing.
      }
    }
  } catch {
    // A package without a readable manifest adds nothing.
  }
  return found;
}

/**
 * The code roots of a process: the engine, the extra roots the caller names (the
 * cli), and for each plugin module its package (or the single file when it has
 * none) with the workspace packages that package depends on.
 */
export function codeRoots(options: {
  readonly home: string;
  readonly extra?: readonly CodeRoot[] | undefined;
  readonly plugins: readonly { readonly name: string; readonly module: string }[];
}): CodeRoot[] {
  const roots: CodeRoot[] = [ENGINE_CODE_ROOT, ...(options.extra ?? [])];
  const seen = new Set(roots.map((root) => root.path));
  const add = (label: string, path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    roots.push({ label, path });
  };
  for (const plugin of options.plugins) {
    const file = pluginFile(plugin.module, options.home);
    if (file === undefined) {
      add(`plugin ${plugin.name}`, resolve(options.home, plugin.module));
      continue;
    }
    const found = packageDirectoryOf(file);
    // A package that holds the operad home is a project, not a plugin's code:
    // watching it would restart on every edit of the project.
    const directory =
      found !== undefined && !(options.home + sep).startsWith(found + sep) ? found : undefined;
    if (directory === undefined) {
      add(`plugin ${plugin.name}`, file);
      continue;
    }
    add(`plugin ${plugin.name}`, directory);
    const queue = workspaceDependencies(directory);
    while (queue.length > 0) {
      const dependency = queue.pop();
      if (dependency === undefined || seen.has(dependency)) continue;
      add(`plugin ${plugin.name}`, dependency);
      queue.push(...workspaceDependencies(dependency));
    }
  }
  return roots;
}

/**
 * Resolves once the files of `roots` differ from `since`. Directory events wake
 * it; a timer reads the files again in case no event came.
 */
export function waitForCodeChange(options: {
  readonly roots: readonly CodeRoot[];
  readonly since: CodeFingerprint;
  readonly cache?: HashCache | undefined;
  readonly pollMs: number;
  readonly clock?: Clock | undefined;
  readonly watch?:
    | ((directory: string, onChange: (filename: string | null) => void) => () => void)
    | undefined;
}): Promise<CodeFingerprint> {
  const clock = options.clock ?? systemClock;
  const watch = options.watch ?? watchDirectory;
  const cache = options.cache ?? newHashCache();
  return new Promise((resolve) => {
    const closers: (() => void)[] = [];
    let timer: unknown;
    let done = false;
    const look = (): void => {
      if (done) return;
      const current = fingerprintCode(options.roots, cache);
      if (diffFingerprints(options.since, current) === undefined) return;
      done = true;
      for (const close of closers) close();
      clock.clearTimeout(timer);
      resolve(current);
    };
    for (const directory of fingerprintCode(options.roots, cache).directories) {
      closers.push(watch(directory, look));
    }
    const tick = (): void => {
      look();
      if (!done) timer = clock.setTimeout(tick, options.pollMs);
    };
    timer = clock.setTimeout(tick, options.pollMs);
    look();
  });
}

/** What `CodeWatch` calls when the code on disk differs from what it loaded. */
export type CodeChangeHandler = (change: CodeChange) => Promise<"reload" | "keep">;

export interface CodeWatchOptions {
  readonly roots: readonly CodeRoot[];
  /**
   * Files that are not code but whose change is worth another try after a
   * change was kept: a settings file that failed to read may be fixed now.
   */
  readonly alsoWatch?: readonly CodeRoot[] | undefined;
  /** What the process loaded; the watch takes its own when omitted. */
  readonly baseline?: CodeFingerprint | undefined;
  /**
   * The files as they were when a change was already tried and kept before this
   * watch started (a serve that fell back to its old code). They count as
   * declined: the handler is offered only what differs from them.
   */
  readonly declined?: CodeFingerprint | undefined;
  /** How long files stay unchanged before the watch acts. */
  readonly quietMs: number;
  /** The timers of the quiet period and the fallback check; tests inject theirs. */
  readonly clock?: Clock | undefined;
  /** How often the files are read again when no event came. */
  readonly pollMs?: number | undefined;
  readonly watch?:
    | ((directory: string, onChange: (filename: string | null) => void) => () => void)
    | undefined;
  /**
   * Called with what changed once files are quiet. "reload" ends the watch;
   * "keep" leaves the process on its old code until the files change again.
   */
  readonly onChange: CodeChangeHandler;
  /**
   * How long a check may run before the watch keeps the old code and tries
   * again later. Zero or less waits without end. Default 90 s.
   */
  readonly checkTimeoutMs?: number | undefined;
  /**
   * How often a kept change is offered again when no file changed: one bad
   * moment must not leave the process on old code for good. Zero retries only
   * at the next change. Default 5 min.
   */
  readonly retryMs?: number | undefined;
  /**
   * Called when a change is kept for a reason the handler could not report
   * itself: the check failed, or it did not finish in `checkTimeoutMs`.
   */
  readonly onKept?: ((change: CodeChange, reason: string) => void) | undefined;
  /**
   * Called when the process starts or stops running older code than the files
   * on disk: true once a change is on disk and the process has not taken it up.
   */
  readonly onOlder?: ((older: boolean) => void) | undefined;
}

/** How long a check may run before the watch keeps the old code by default. */
export const DEFAULT_CHECK_TIMEOUT_MS = 90_000;

/** How often a kept change is offered again by default. */
export const DEFAULT_RETRY_MS = 300_000;

/** A duration as the log line says it, in seconds. */
export function secondsOf(ms: number): string {
  const seconds = ms / 1_000;
  return `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10} s`;
}

/** Watches code files and reports a change once, after a quiet period. */
export class CodeWatch {
  private readonly options: CodeWatchOptions;
  private readonly clock: Clock;
  private readonly cache = newHashCache();
  private baseline: CodeFingerprint | undefined;
  private readonly watchers = new Map<string, () => void>();
  private quiet: unknown;
  private poll: unknown;
  /** The timer that ends a check that runs too long. */
  private checkTimer: unknown;
  /** The timer that offers a kept change again. */
  private retry: unknown;
  /** Set by the retry timer, so the next check offers the kept change again. */
  private retryWanted = false;
  private busy = false;
  private closed = false;
  private older = false;
  /** The change the handler last kept, so the same files are not offered twice. */
  private declined:
    | { readonly code: CodeFingerprint; readonly settings: CodeFingerprint }
    | undefined;

  constructor(options: CodeWatchOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.baseline = options.baseline;
  }

  /** Takes the baseline when none was given and starts watching. */
  start(): void {
    const current = fingerprintCode(this.options.roots, this.cache);
    this.baseline ??= current;
    const settings = this.settings();
    if (this.options.declined !== undefined) {
      this.declined = { code: this.options.declined, settings };
    }
    // Code that already differs from the baseline at the start is older now.
    this.setOlder(diffFingerprints(this.baseline, current) !== undefined);
    this.sync(current, settings);
    const pollMs = this.options.pollMs ?? 5_000;
    const tick = (): void => {
      if (this.closed) return;
      this.schedule();
      this.poll = this.clock.setTimeout(tick, pollMs);
    };
    this.poll = this.clock.setTimeout(tick, pollMs);
  }

  stop(): void {
    this.closed = true;
    if (this.quiet !== undefined) this.clock.clearTimeout(this.quiet);
    if (this.poll !== undefined) this.clock.clearTimeout(this.poll);
    if (this.checkTimer !== undefined) this.clock.clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.cancelRetry();
    for (const close of this.watchers.values()) close();
    this.watchers.clear();
  }

  private planRetry(): void {
    const retryMs = this.options.retryMs ?? DEFAULT_RETRY_MS;
    if (this.closed || retryMs <= 0 || this.retry !== undefined) return;
    this.retry = this.clock.setTimeout(() => {
      this.retry = undefined;
      this.retryWanted = true;
      this.schedule();
    }, retryMs);
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) this.clock.clearTimeout(this.retry);
    this.retry = undefined;
  }

  private setOlder(older: boolean): void {
    if (this.older === older) return;
    this.older = older;
    this.options.onOlder?.(older);
  }

  private settings(): CodeFingerprint {
    return fingerprintCode(this.options.alsoWatch ?? [], this.cache);
  }

  private sync(code: CodeFingerprint, settings: CodeFingerprint): void {
    const watch = this.options.watch ?? watchDirectory;
    const directories = new Set([...code.directories, ...settings.directories]);
    const fingerprint = { directories };
    for (const [directory, close] of [...this.watchers]) {
      if (!fingerprint.directories.has(directory)) {
        close();
        this.watchers.delete(directory);
      }
    }
    for (const directory of fingerprint.directories) {
      if (this.watchers.has(directory)) continue;
      this.watchers.set(
        directory,
        watch(directory, () => {
          this.schedule();
        }),
      );
    }
  }

  /** Every event restarts the quiet period; a stop in progress ignores it. */
  private schedule(): void {
    if (this.closed || this.busy) return;
    if (this.quiet !== undefined) this.clock.clearTimeout(this.quiet);
    this.quiet = this.clock.setTimeout(() => {
      this.quiet = undefined;
      this.check().catch(() => {
        // An unexpected failure keeps the old code; the next change or the
        // slow timer tries again.
        this.busy = false;
      });
    }, this.options.quietMs);
  }

  /**
   * Runs the handler, but not without end: a check that never finishes must
   * not stop the watch. A failure or a timeout is a kept change with a reason.
   */
  private answerWithin(
    change: CodeChange,
  ): Promise<{ readonly answer: "reload" | "keep"; readonly reason?: string | undefined }> {
    const timeoutMs = this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { answer: "reload" | "keep"; reason?: string }): void => {
        if (settled) return;
        settled = true;
        if (this.checkTimer !== undefined) this.clock.clearTimeout(this.checkTimer);
        this.checkTimer = undefined;
        resolve(value);
      };
      if (timeoutMs > 0) {
        this.checkTimer = this.clock.setTimeout(() => {
          finish({
            answer: "keep",
            reason: `the check did not finish within ${secondsOf(timeoutMs)}`,
          });
        }, timeoutMs);
      }
      let running: Promise<"reload" | "keep">;
      try {
        running = Promise.resolve(this.options.onChange(change));
      } catch (error) {
        finish({ answer: "keep", reason: `the check failed: ${messageOf(error)}` });
        return;
      }
      running.then(
        (answer) => finish({ answer }),
        (error: unknown) =>
          finish({ answer: "keep", reason: `the check failed: ${messageOf(error)}` }),
      );
    });
  }

  private async check(): Promise<void> {
    if (this.closed || this.busy || this.baseline === undefined) return;
    const current = fingerprintCode(this.options.roots, this.cache);
    const settings = this.settings();
    this.sync(current, settings);
    const change = diffFingerprints(this.baseline, current);
    if (change === undefined) {
      this.retryWanted = false;
      this.cancelRetry();
      this.setOlder(false);
      return;
    }
    if (
      !this.retryWanted &&
      this.declined !== undefined &&
      diffFingerprints(this.declined.code, current) === undefined &&
      diffFingerprints(this.declined.settings, settings) === undefined
    ) {
      // This change was tried and kept; the slow timer offers it again.
      this.setOlder(true);
      this.planRetry();
      return;
    }
    this.retryWanted = false;
    this.cancelRetry();
    this.busy = true;
    let answer: "reload" | "keep" = "keep";
    try {
      const outcome = await this.answerWithin(change);
      answer = outcome.answer;
      if (outcome.reason !== undefined) this.options.onKept?.(change, outcome.reason);
    } finally {
      if (answer === "reload") {
        this.stop();
      } else if (this.closed) {
        this.busy = false;
      } else {
        this.declined = { code: current, settings };
        this.busy = false;
        this.setOlder(true);
        this.planRetry();
      }
    }
  }
}
