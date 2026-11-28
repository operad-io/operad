/**
 * The packages `operad serve` installs once it is serving (ADR 0012 D4,
 * ADR 0023 D9), so no start waits for a download. A failure is not serve's
 * failure: the plugin stays as it was and the next start tries again.
 */

import { messageOf, standInModule, type OperadConfig } from "@operad-io/engine";

type Entry = OperadConfig["plugins"][number];

export interface AfterStartOptions {
  readonly entries: readonly Entry[];
  /** Installs what the entry needs; true when there was something to install. */
  readonly install: (entry: Entry) => Promise<boolean>;
  /** An aborted signal means serve is stopping: nothing more starts and nothing is reported. */
  readonly signal: AbortSignal;
  /** Receives the one line that says why a plugin is not set up. */
  readonly onFailure: (name: string, reason: string) => Promise<void>;
  /**
   * The names `awaitedPlugins` gave. One leaves when no reload will follow for
   * it: its install failed or had nothing to do.
   */
  readonly awaited?: Set<string> | undefined;
}

/**
 * The plugins a stand-in loads for among `entries`: each is about to start,
 * once its package is installed and serve has reloaded (ADR 0029 D4).
 */
export function awaitedPlugins(
  home: string,
  entries: readonly Entry[],
  standIns: Readonly<Record<string, string>>,
): Set<string> {
  return new Set(
    entries
      .filter((entry) => entry.enabled && standInModule(home, entry.module, standIns) !== undefined)
      .flatMap((entry) => (entry.name === undefined ? [] : [entry.name])),
  );
}

/** Installs one after another, as they share one project; answers the names newly installed. */
export async function installAfterStart(options: AfterStartOptions): Promise<readonly string[]> {
  const installed: string[] = [];
  for (const entry of options.entries) {
    if (options.signal.aborted) break;
    const name = entry.name ?? entry.module;
    try {
      if (await options.install(entry)) installed.push(name);
      else options.awaited?.delete(name);
    } catch (error) {
      if (options.signal.aborted) break;
      options.awaited?.delete(name);
      await options.onFailure(name, messageOf(error).replace(/\s+/g, " ").trim());
    }
  }
  return installed;
}
