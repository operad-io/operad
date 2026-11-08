/**
 * Keeping `serve` and each run's process on the code that is on disk.
 *
 * A process records a fingerprint of the code it loaded. When the files change,
 * a fresh process is started to load them (`check-load`) before anything is
 * given up: code that does not load leaves the old process running and its
 * problems on the error stream, and the next change tries again.
 */

import {
  describeChange,
  diffFingerprints,
  fingerprintCode,
  newHashCache,
  codeRoots,
  waitForCodeChange,
} from "@operad-io/engine";
import type { CodeFingerprint, CodeRoot } from "@operad-io/engine";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));

/** The cli package: its sources and schemas are code every process loads. */
export const CLI_CODE_ROOT: CodeRoot = {
  label: "cli",
  path: fileURLToPath(new URL("../", import.meta.url)),
};

/** The files of the home a process reads at each use; a failed load tries again when they change. */
export function settingsRoots(home: string): CodeRoot[] {
  return ["config.json", "triggers.json", "keys.json"].map((name) => ({
    label: "settings",
    path: join(home, name),
  }));
}

/** The code a process loaded, and where to read it again. */
export interface CodeSnapshot {
  readonly roots: readonly CodeRoot[];
  readonly baseline: CodeFingerprint;
  readonly cache: ReturnType<typeof newHashCache>;
}

export function takeCodeSnapshot(
  home: string,
  plugins: readonly { readonly name: string | undefined; readonly module: string; readonly enabled: boolean }[],
): CodeSnapshot {
  const roots = codeRoots({
    home,
    extra: [CLI_CODE_ROOT],
    plugins: plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => ({ name: plugin.name ?? basename(plugin.module, extname(plugin.module)), module: plugin.module })),
  });
  const cache = newHashCache();
  return { roots, baseline: fingerprintCode(roots, cache), cache };
}

/** What a plugin problem line is about: its plugin, else the line itself. */
export function problemKey(line: string): string {
  return /^plugin "([^"]+)"/.exec(line)?.[1] ?? line;
}

/**
 * New code may be taken up when it loads, or when its only problems are ones
 * the process already had.
 */
export function loadsAsWellAs(
  problems: readonly string[],
  known: readonly string[],
): boolean {
  const keys = new Set(known.map(problemKey));
  return problems.every((line) => keys.has(problemKey(line)));
}

/**
 * Starts a fresh process that loads the code on disk and reports what did not
 * load, one line each. A process that cannot start reports that as the problem.
 */
export async function probeLoad(home: string): Promise<string[]> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "check-load"],
    cwd: home,
    env: { ...process.env, OPERAD_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    const last = err
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3)
      .join(" ");
    return [`operad does not start: ${last.length > 0 ? last : `exit ${code}`}`];
  }
  return out.split("\n").filter((line) => line.length > 0);
}

export interface CodeCheckOptions {
  readonly home: string;
  readonly snapshot: CodeSnapshot;
  /** The problems this process had when it loaded. */
  readonly known: readonly string[];
  readonly onProblem: (message: string) => void;
  /**
   * When set, a change that does not load is waited out instead of skipped:
   * the check does not return until the files load or match what the process
   * loaded again. A run's process needs this, because the next step's code is
   * read from disk.
   */
  readonly waitPollMs?: number | undefined;
}

/**
 * Compares the code on disk with what the process loaded. Returns what changed
 * when the new code loads, and undefined when nothing changed or the change
 * does not load. With `waitPollMs` a change that does not load is waited out.
 */
export function codeChecker(
  options: CodeCheckOptions,
): () => Promise<string | undefined> {
  return async () => {
    let current = fingerprintCode(options.snapshot.roots, options.snapshot.cache);
    for (;;) {
      // What the wait compares with is read before the load is tried, so a fix
      // that lands during the try is not missed.
      const watched = [...options.snapshot.roots, ...settingsRoots(options.home)];
      const seen = fingerprintCode(watched, options.snapshot.cache);
      const change = diffFingerprints(options.snapshot.baseline, current);
      if (change === undefined) return undefined;
      const problems = await probeLoad(options.home);
      if (loadsAsWellAs(problems, options.known)) return describeChange(change);
      options.onProblem(
        `code changed (${describeChange(change)}) but does not load; the old code keeps running: ${problems.join("; ")}`,
      );
      if (options.waitPollMs === undefined) return undefined;
      // A settings file that did not read may be fixed, so it wakes the wait
      // too; the code is judged again either way.
      await waitForCodeChange({
        roots: watched,
        since: seen,
        cache: options.snapshot.cache,
        pollMs: options.waitPollMs,
      });
      current = fingerprintCode(options.snapshot.roots, options.snapshot.cache);
    }
  };
}

/** Starts the same command line again once this process is gone. */
export function reexecServe(): void {
  const child = Bun.spawn({
    cmd: [process.execPath, ...process.argv.slice(1)],
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  child.unref();
}
