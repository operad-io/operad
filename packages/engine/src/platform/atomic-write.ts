/**
 * Writing a file whole. A writer puts the new text in a temporary file in the
 * same directory, flushes it, then renames it over the target, so a crash or a
 * second writer leaves the old file or the new one, never half of either.
 *
 * The temporary name carries the process id and a random value, so two writers
 * never share one. Writing through one helper also keeps the target's mode: a
 * file that already exists keeps it, and a caller that names a mode gets it
 * exactly, even under a umask.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** What a synchronous atomic write may adjust. */
export interface AtomicWriteOptions {
  /** The mode the file has afterwards; default keeps the mode of a file that exists. */
  readonly mode?: number | undefined;
  /** Called once the temporary file is complete, before it replaces the target. */
  readonly beforeRename?:
    | ((temporary: string, file: string) => void)
    | undefined;
}

/** What an asynchronous atomic write may adjust. */
export interface AsyncAtomicWriteOptions {
  /** The mode the file has afterwards; default keeps the mode of a file that exists. */
  readonly mode?: number | undefined;
  /** Called once the temporary file is complete, before it replaces the target. */
  readonly beforeRename?:
    | ((temporary: string, file: string) => Promise<void> | void)
    | undefined;
}

/** How a JSON value is written; the file gets a newline unless told otherwise. */
export interface JsonWriteOptions extends AtomicWriteOptions {
  /** The indentation `JSON.stringify` uses; none by default. */
  readonly space?: number | undefined;
  /** Whether a newline follows the JSON; true by default. */
  readonly newline?: boolean | undefined;
}

/** The asynchronous form of {@link JsonWriteOptions}. */
export interface AsyncJsonWriteOptions extends AsyncAtomicWriteOptions {
  /** The indentation `JSON.stringify` uses; none by default. */
  readonly space?: number | undefined;
  /** Whether a newline follows the JSON; true by default. */
  readonly newline?: boolean | undefined;
}

function temporaryPath(file: string): string {
  return join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function jsonText(value: unknown, space: number | undefined, newline: boolean): string {
  const text = JSON.stringify(value, null, space);
  return newline ? `${text}\n` : text;
}

/**
 * Writes `text` to `path` through a temporary file and a rename. The parent
 * directory is created when it is missing.
 */
export async function writeFileAtomic(
  path: string,
  text: string,
  options: AsyncAtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  const existing = await stat(path).then(
    (info) => info.mode & 0o777,
    () => undefined,
  );
  const mode = options.mode ?? existing;
  try {
    const handle = await open(temporary, "w", options.mode ?? 0o666);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await chmod(temporary, mode);
    await options.beforeRename?.(temporary, path);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The synchronous form of {@link writeFileAtomic}. */
export function writeFileAtomicSync(
  path: string,
  text: string,
  options: AtomicWriteOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  const existing = readMode(path);
  const mode = options.mode ?? existing;
  try {
    const fd = openSync(temporary, "w", options.mode ?? 0o666);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (mode !== undefined) chmodSync(temporary, mode);
    options.beforeRename?.(temporary, path);
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file was never made, or is already gone.
    }
    throw error;
  }
}

function readMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Writes `value` as JSON through a temporary file and a rename. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AsyncJsonWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(path, jsonText(value, options.space, options.newline ?? true), options);
}

/** The synchronous form of {@link writeJsonAtomic}. */
export function writeJsonAtomicSync(
  path: string,
  value: unknown,
  options: JsonWriteOptions = {},
): void {
  writeFileAtomicSync(path, jsonText(value, options.space, options.newline ?? true), options);
}
