/** The terminal plugin: commands on pseudo terminals that `operad serve` keeps (ADR 0040). */

import pkg from "../package.json" with { type: "json" };
import { definePlugin } from "@operad-io/engine";
import type { Clock } from "@operad-io/engine/platform";
import { TerminalHost, type HostOptions } from "./host.ts";
import { terminalHttp } from "./http.ts";

export * from "./escape.ts";
export * from "./folders.ts";
export * from "./host.ts";
export * from "./http.ts";
export * from "./queue.ts";
export * from "./replay.ts";
export * from "./session.ts";

/** What a test replaces. */
export interface TerminalPluginOptions {
  /** The login shell; default `$SHELL`. */
  readonly shell?: string | undefined;
  /** Added over serve's environment in each terminal. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly clock?: Clock | undefined;
  readonly repeat?: HostOptions["repeat"];
}

/** The person's login shell, or the system's usual one when serve's environment names none. */
export function loginShell(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const shell = env.SHELL;
  if (shell !== undefined && shell !== "") return shell;
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

export function createTerminalPlugin(options: TerminalPluginOptions = {}) {
  return definePlugin({
    name: "terminal",
    kind: "domain",
    version: pkg.version,
    startsWithoutRules: true,
    start(ctx) {
      const host = new TerminalHost({
        home: ctx.home,
        store: ctx.store,
        repositories: ctx.repositories ?? (async () => []),
        harnesses: () => ctx.harnesses ?? [],
        harnessCommand: ctx.harnessCommand ?? (async () => undefined),
        shell: options.shell ?? loginShell(),
        env: options.env ?? {},
        now: ctx.clock,
        clock: options.clock,
        repeat: options.repeat,
        onLog: (message) => {
          void ctx.logger.write(`${message}\n`).catch(() => undefined);
        },
      });
      return { stop: () => host.stop(), http: terminalHttp(host) };
    },
  });
}

export default createTerminalPlugin();
