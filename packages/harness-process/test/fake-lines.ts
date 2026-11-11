/**
 * The plumbing of a stand-in for a harness child program that prints fixed
 * lines: it reads the stdin object, records it, and offers the helpers a mode
 * needs. A harness's own `fake-lines-worker.ts` keeps its modes and its result
 * line, which differ by harness.
 *
 * Environment, with `prefix` such as `FAKE_CLAUDE`: `<prefix>_MODE`,
 * `<prefix>_RECORD` (the stdin object is written there), `<prefix>_MARKER` (the
 * pid is written there once the program is running), `<prefix>_RELEASE` (a path
 * the program waits for).
 */

import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FakeLinesProgram {
  readonly mode: string;
  readonly recordPath: string | undefined;
  /** The stdin object: the first line. */
  readonly input: Record<string, unknown> & { readonly cwd: string };
  /** The next stdin line; stdin stays open so the host can answer later. */
  stdinLine(): Promise<string>;
  /** Writes one JSON line to stdout. */
  line(value: unknown): void;
  /** Writes the pid to the marker file. */
  mark(): void;
  /** Resolves when the release file exists; a look every 100 ms backs the directory watch. */
  released(): Promise<void>;
  hang(): Promise<never>;
}

export async function startFakeLines(prefix: string): Promise<FakeLinesProgram> {
  const mode = process.env[`${prefix}_MODE`] ?? "done";
  const recordPath = process.env[`${prefix}_RECORD`];
  const marker = process.env[`${prefix}_MARKER`];
  const release = process.env[`${prefix}_RELEASE`];

  const reader = Bun.stdin.stream().getReader();
  let buffered = "";
  const decoder = new TextDecoder();
  async function stdinLine(): Promise<string> {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const found = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return found;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        const rest = buffered;
        buffered = "";
        return rest;
      }
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  }

  const input = JSON.parse(await stdinLine()) as Record<string, unknown> & { cwd: string };
  if (recordPath !== undefined) writeFileSync(recordPath, JSON.stringify(input));

  return {
    mode,
    recordPath,
    input,
    stdinLine,
    line(value) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
    },
    mark() {
      if (marker !== undefined) writeFileSync(marker, String(process.pid));
    },
    released() {
      if (release === undefined || existsSync(release)) return Promise.resolve();
      const path = release;
      return new Promise((resolve) => {
        const check = (): void => {
          if (!existsSync(path)) return;
          watcher.close();
          clearInterval(timer);
          resolve();
        };
        const watcher = watch(dirname(path), check);
        const timer = setInterval(check, 100);
        check();
      });
    },
    hang: () => new Promise<never>(() => {}),
  };
}
