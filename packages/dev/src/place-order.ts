/**
 * The order in which waiting checks take places: first come, first served. Each
 * waiting check keeps one small file per pool next to the place lock files,
 * named by the pool, the time it began to wait and its pid, so separate
 * processes agree on the order. A file whose process is dead is removed by
 * whoever reads it, the same dead-pid rule the place locks use.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "@operad-io/engine/platform";

interface Entry {
  readonly file: string;
  readonly pool: string;
  readonly since: number;
  readonly pid: number;
  readonly nonce: string;
}

let counter = 0;
const PREFIX = "queue-";
const SUFFIX = ".wait";

function parse(file: string): Entry | undefined {
  if (!file.startsWith(PREFIX) || !file.endsWith(SUFFIX)) return undefined;
  const parts = file.slice(PREFIX.length, -SUFFIX.length).split("-");
  const nonce = parts.pop();
  const pid = Number(parts.pop());
  const since = Number(parts.pop());
  const pool = parts.join("-");
  if (nonce === undefined || pool === "" || !Number.isInteger(pid) || !Number.isFinite(since)) {
    return undefined;
  }
  return { file, pool, since, pid, nonce };
}

function before(left: Entry, right: Entry): boolean {
  if (left.since !== right.since) return left.since < right.since;
  if (left.pid !== right.pid) return left.pid < right.pid;
  return left.nonce < right.nonce;
}

/** The live entries of one pool, first in line first; dead ones are removed. */
function live(directory: string, pool: string): Entry[] {
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const file of files) {
    const entry = parse(file);
    if (entry === undefined || entry.pool !== pool) continue;
    if (!isAlive(entry.pid)) {
      try {
        unlinkSync(join(directory, file));
      } catch {
        // Another reader removed it first.
      }
      continue;
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => (before(a, b) ? -1 : 1));
}

/** One check's place in the order of one pool. */
export class WaitEntry {
  private readonly file: string;
  private removed = false;

  private constructor(
    private readonly directory: string,
    private readonly pool: string,
    readonly since: number,
    private readonly nonce: string,
  ) {
    this.file = `${PREFIX}${pool}-${String(since).padStart(16, "0")}-${process.pid}-${nonce}${SUFFIX}`;
  }

  /** Joins the order of `pool` as having begun to wait at `since`. */
  static join(directory: string, pool: string, since: number): WaitEntry {
    mkdirSync(directory, { recursive: true });
    // Checks of one process that began in the same millisecond keep their call order.
    counter += 1;
    const nonce = String(counter).padStart(10, "0");
    const entry = new WaitEntry(directory, pool, since, nonce);
    writeFileSync(join(directory, entry.file), "");
    return entry;
  }

  /** How many live checks began to wait before this one for the pool. */
  ahead(): number {
    const mine = parse(this.file);
    if (mine === undefined) return 0;
    return live(this.directory, this.pool).filter((other) => before(other, mine)).length;
  }

  /** Leaves the order; safe to call again. */
  leave(): void {
    if (this.removed) return;
    this.removed = true;
    try {
      unlinkSync(join(this.directory, this.file));
    } catch {
      // Already removed, for example by a reader that saw this process dead.
    }
  }
}
