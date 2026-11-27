/**
 * Process trees that work in a folder, listed in the home, so whoever is about
 * to remove the folder can stop them first. The one that keeps a process holds
 * its folder; the one that removes a folder releases it. Neither needs to know
 * the other, and a release never waits for the processes it stops.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./atomic-write.ts";
import { processTree, signalRows } from "./process-tree.ts";
import { readProcessTable, type ProcessTable } from "./step-reap.ts";

/** The directory in a home that lists the held folders. */
export const FOLDER_HOLDS_DIRECTORY = "folder-holds";

interface HoldRecord {
  /** The root of the tree that works in the folder. */
  readonly pid: number;
  /** The process that started it; the root is its child while both live. */
  readonly owner: number;
  readonly folder: string;
  readonly released: boolean;
}

export interface FolderHold {
  /** Whether someone released the folder, and so stopped the tree. */
  released(): boolean;
  /** Takes the hold off the list; call it when the tree ended. */
  drop(): void;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readRecord(file: string): HoldRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<HoldRecord>;
    const { pid, owner, folder, released } = value;
    if (typeof pid !== "number" || typeof owner !== "number") return undefined;
    if (typeof folder !== "string" || typeof released !== "boolean") return undefined;
    return { pid, owner, folder, released };
  } catch {
    return undefined;
  }
}

/** Records that the tree under `pid`, a child of this process, works in `folder`. */
export function holdFolder(options: {
  readonly home: string;
  readonly folder: string;
  readonly pid: number;
}): FolderHold {
  const directory = join(options.home, FOLDER_HOLDS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${options.pid}-${randomUUID()}.json`);
  const record: HoldRecord = {
    pid: options.pid,
    owner: process.pid,
    folder: canonical(options.folder),
    released: false,
  };
  writeJsonAtomicSync(file, record);
  let released = false;
  const look = (): boolean => (released ||= readRecord(file)?.released === true);
  return {
    released: look,
    drop: () => {
      // The answer stays readable after the file is gone.
      look();
      rmSync(file, { force: true });
    },
  };
}

/**
 * Stops, by force and without waiting, every held tree whose folder is `folder`
 * or inside it. Call it just before removing the folder. It never throws, so a
 * removal cannot fail because of it, and answers how many holds it stopped.
 */
export async function releaseFolder(
  home: string,
  folder: string,
  options: { readonly table?: ProcessTable | undefined } = {},
): Promise<number> {
  try {
    const directory = join(home, FOLDER_HOLDS_DIRECTORY);
    if (!existsSync(directory)) return 0;
    const target = canonical(folder);
    const held: { readonly file: string; readonly record: HoldRecord }[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const file = join(directory, name);
      const record = readRecord(file);
      if (record === undefined) continue;
      if (record.folder !== target && !record.folder.startsWith(`${target}${sep}`)) continue;
      held.push({ file, record });
    }
    if (held.length === 0) return 0;
    const rows = await (options.table ?? readProcessTable)();
    let stopped = 0;
    for (const { file, record } of held) {
      // A hold left by a process that was killed names a pid that may be
      // another's by now: only a child of the holder is stopped.
      if (!rows.some((row) => row.pid === record.pid && row.ppid === record.owner)) {
        rmSync(file, { force: true });
        continue;
      }
      // Written first, so the holder that sees its process end knows why.
      writeJsonAtomicSync(file, { ...record, released: true });
      signalRows(processTree(rows, record.pid), "SIGKILL");
      stopped += 1;
    }
    return stopped;
  } catch {
    return 0;
  }
}
