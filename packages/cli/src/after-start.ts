/**
 * The packages `operad serve` installs once it is serving (ADR 0012 D4,
 * ADR 0023 D9), so no start waits for a download. A failure is not serve's
 * failure: the plugin stays as it was and the next start tries again.
 */

import { messageOf, type OperadConfig } from "@operad-io/engine";

type Entry = OperadConfig["plugins"][number];

export interface AfterStartOptions {
  readonly entries: readonly Entry[];
  /** Installs what the entry needs; true when there was something to install. */
  readonly install: (entry: Entry) => Promise<boolean>;
  /** An aborted signal means serve is stopping: nothing more starts and nothing is reported. */
  readonly signal: AbortSignal;
  /** Receives the one line that says why a plugin is not set up. */
  readonly onFailure: (name: string, reason: string) => Promise<void>;
}

/** Installs one after another, as they share one project; answers the names newly installed. */
export async function installAfterStart(options: AfterStartOptions): Promise<readonly string[]> {
  const installed: string[] = [];
  for (const entry of options.entries) {
    if (options.signal.aborted) break;
    const name = entry.name ?? entry.module;
    try {
      if (await options.install(entry)) installed.push(name);
    } catch (error) {
      if (options.signal.aborted) break;
      await options.onFailure(name, messageOf(error).replace(/\s+/g, " ").trim());
    }
  }
  return installed;
}
