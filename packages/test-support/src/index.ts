/** Running the real command-line entry, for a test only. */

import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

const CLI_ENTRY = fileURLToPath(
  new URL("../../cli/bin/operad.ts", import.meta.url),
);

export interface OperadOptions {
  /** The child's working directory. Default: `home`. */
  readonly cwd?: string;
  /** More environment entries; a `undefined` value removes the variable. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Standard input. Default: an empty, ignored stdin. */
  readonly input?: string | Readable;
  /** The entry file. Default: this repository's `packages/cli/bin/operad.ts`. */
  readonly entry?: string;
}

export interface OperadResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * Starts the CLI's real entry with `OPERAD_HOME` set to `home`, then collects
 * its exit code, output and errors. The environment starts from this process's
 * own, minus the supervisor flag a test run inside a serve carries.
 */
export async function operad(
  home: string,
  args: readonly string[],
  options: OperadOptions = {},
): Promise<OperadResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.OPERAD_SERVE_SUPERVISED;
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  env.OPERAD_HOME = home;
  const child = Bun.spawn({
    cmd: [process.execPath, options.entry ?? CLI_ENTRY, ...args],
    cwd: options.cwd ?? home,
    env,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined) {
    const stdin = child.stdin;
    if (stdin === undefined) throw new Error("the child has no stdin pipe");
    if (typeof options.input === "string") {
      stdin.write(options.input);
    } else {
      for await (const chunk of options.input) {
        stdin.write(chunk);
      }
    }
    // Not awaited: the output is read below, and waiting for the pipe to drain first could block a child that writes before it reads.
    void stdin.end();
  }
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}
