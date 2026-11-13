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
  ENGINE_CODE_ROOT,
  waitForCodeChange,
} from "@operad-io/engine";
import type { CodeFingerprint, CodeRoot } from "@operad-io/engine";
import { basename, extname, join, sep } from "node:path";
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
  // config.json holds each plugin's settings, which a plugin is given when it
  // loads: a change to it (by hand or through `settings set`) is taken up the
  // way changed code is.
  roots.push({ label: "settings", path: join(home, "config.json") });
  const cache = newHashCache();
  return { roots, baseline: fingerprintCode(roots, cache), cache };
}

/**
 * The snapshot of a serve that runs again in a process that loaded its kernel
 * code earlier (the supervisor restoring the old code after a restart could not
 * listen). The plugins were loaded from disk just now, but the engine and cli
 * modules are the ones `earlier` saw: their files take the earlier hashes, so
 * the watch sees a change when they differ on disk.
 */
export function keepKernelBaseline(now: CodeSnapshot, earlier: CodeFingerprint): CodeSnapshot {
  const kernel = [ENGINE_CODE_ROOT.path, CLI_CODE_ROOT.path].map((path) =>
    path.endsWith(sep) ? path : path + sep,
  );
  const inKernel = (file: string): boolean => kernel.some((root) => file.startsWith(root));
  const hashes = new Map([...now.baseline.hashes].filter(([file]) => !inKernel(file)));
  const labels = new Map([...now.baseline.labels].filter(([file]) => !inKernel(file)));
  for (const [file, hash] of earlier.hashes) {
    if (!inKernel(file)) continue;
    hashes.set(file, hash);
    const label = earlier.labels.get(file);
    if (label !== undefined) labels.set(file, label);
  }
  return {
    ...now,
    baseline: { hashes, labels, directories: now.baseline.directories },
  };
}

/**
 * A problem line, without the counter the loader adds to every import. Two
 * lines are the same problem only when they say the same thing: a plugin that
 * fails in another way (an import that no longer works, after its tick failed)
 * is a new problem.
 */
export function problemKey(line: string): string {
  return line
    .replace(/[?&]operad-plugin-load=\d+/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
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

/** Set in the environment of a serve that a supervisor started. */
export const SUPERVISED_ENV = "OPERAD_SERVE_SUPERVISED";

/**
 * True when a supervisor started this serve. Removes the flag from `env`, so
 * no process the serve starts (run processes, steps, their commands) sees it.
 */
export function takeSupervisedFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const supervised = env[SUPERVISED_ENV] === "1";
  delete env[SUPERVISED_ENV];
  return supervised;
}

/** The exit code of a serve that stopped only to load new code. */
export const RELOAD_EXIT = 75;

/**
 * The exit code of a supervised serve that could not listen on every address
 * in time: the supervisor then serves with the code it already has.
 */
export const BIND_FAILED_EXIT = 76;

/**
 * Starts the same command line again, in place: the process the user (or a
 * supervisor) started stays, with its terminal and its process group, and runs
 * the serve as a child with the same arguments and environment. It starts the
 * child again each time the child stops for new code, passes a stop signal on,
 * and ends with the child's exit code.
 */
export async function superviseServe(
  restore?: () => Promise<"stopped" | "reload">,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  let stopping: NodeJS.Signals | undefined;
  let child: Bun.Subprocess | undefined;
  const pass = (signal: NodeJS.Signals) => (): void => {
    stopping = signal;
    child?.kill(signal);
  };
  const interrupt = pass("SIGINT");
  const terminate = pass("SIGTERM");
  const attach = (): void => {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
  };
  const detach = (): void => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
  attach();
  try {
    for (;;) {
      child = Bun.spawn({
        cmd: [process.execPath, ...process.argv.slice(1)],
        cwd: process.cwd(),
        env: { ...process.env, [SUPERVISED_ENV]: "1" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      if (stopping !== undefined) child.kill(stopping);
      const code = await child.exited;
      // A stop that reached the supervisor while the child left for new code is still a stop.
      if (stopping !== undefined) return code === RELOAD_EXIT ? 0 : code;
      if (code === BIND_FAILED_EXIT && restore !== undefined) {
        // The new code could not take the addresses. The code this process
        // runs served them before: it serves again, and takes its own signals.
        child = undefined;
        detach();
        let outcome: "stopped" | "reload";
        try {
          outcome = await restore();
        } catch (error) {
          // The old code is gone too: say so rather than leave the one line
          // that promised its addresses standing as the last word.
          log(
            `reload: the old code could not listen either (${error instanceof Error ? error.message : String(error)}); this serve ends\n`,
          );
          throw error;
        } finally {
          attach();
        }
        if (outcome === "stopped") return 0;
        continue;
      }
      if (code !== RELOAD_EXIT) return code;
    }
  } finally {
    detach();
  }
}
