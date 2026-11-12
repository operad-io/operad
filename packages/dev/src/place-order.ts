/**
 * The order in which waiting checks take places. Integration checks go before
 * verify checks, so a verified task can reach main without waiting behind every
 * task check on the machine; among each kind the order is first come, first
 * served. A verify that has waited longer than `VERIFY_STARVATION_MS` goes
 * before the integration checks, so no verify waits forever.
 *
 * Each waiting check keeps one small file per pool next to the place lock files,
 * named by the pool, the time it began to wait, its pid and its kind, so
 * separate processes agree on the order. A file whose process is dead is
 * removed by whoever reads it, the same dead-pid rule the place locks use.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "@operad-io/engine/platform";

/** What a check is for: an integration lands a verified task, a verify checks one. */
export type CheckKind = "integration" | "verify";

/**
 * How long a verify may wait before it goes before the integration checks. It
 * is longer than one integration check usually takes, so the integrations of a
 * queue still drain first, and short enough that a verify cannot be starved for
 * an afternoon by a stream of integrations.
 */
export const VERIFY_STARVATION_MS = 30 * 60 * 1000;

interface Entry {
  readonly file: string;
  readonly pool: string;
  readonly kind: CheckKind;
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
  // New entries end in their kind; an entry written before kinds existed has
  // none, and is a verify.
  let kind: CheckKind = "verify";
  const last = parts.at(-1);
  if (last === "integration" || last === "verify") {
    kind = last;
    parts.pop();
  }
  const nonce = parts.pop();
  const pid = Number(parts.pop());
  const since = Number(parts.pop());
  const pool = parts.join("-");
  if (nonce === undefined || pool === "" || !Number.isInteger(pid) || !Number.isFinite(since)) {
    return undefined;
  }
  return { file, pool, kind, since, pid, nonce };
}

function starved(entry: Entry, now: number): boolean {
  return entry.kind === "verify" && now - entry.since > VERIFY_STARVATION_MS;
}

function before(left: Entry, right: Entry, now: number): boolean {
  const leftStarved = starved(left, now);
  const rightStarved = starved(right, now);
  if (leftStarved !== rightStarved) return leftStarved;
  if (!leftStarved && left.kind !== right.kind) {
    return left.kind === "integration";
  }
  if (left.since !== right.since) return left.since < right.since;
  if (left.pid !== right.pid) return left.pid < right.pid;
  return left.nonce < right.nonce;
}

/** The live entries of one pool; dead ones are removed. */
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
  return entries;
}

/** One check's place in the order of one pool. */
export class WaitEntry {
  private readonly file: string;
  private removed = false;

  private constructor(
    private readonly directory: string,
    private readonly pool: string,
    private readonly kind: CheckKind,
    readonly since: number,
    private readonly nonce: string,
  ) {
    this.file = `${PREFIX}${pool}-${String(since).padStart(16, "0")}-${process.pid}-${nonce}-${kind}${SUFFIX}`;
  }

  /** Joins the order of `pool` as having begun to wait at `since`. */
  static join(
    directory: string,
    pool: string,
    since: number,
    kind: CheckKind = "verify",
  ): WaitEntry {
    mkdirSync(directory, { recursive: true });
    // Checks of one process that began in the same millisecond keep their call order.
    counter += 1;
    const nonce = String(counter).padStart(10, "0");
    const entry = new WaitEntry(directory, pool, kind, since, nonce);
    writeFileSync(join(directory, entry.file), "");
    return entry;
  }

  /** How many live checks go before this one for the pool. */
  ahead(now: number = Date.now()): number {
    const mine = parse(this.file);
    if (mine === undefined) return 0;
    return live(this.directory, this.pool).filter((other) => before(other, mine, now)).length;
  }

  /** How many live integration checks go before this one. */
  integrationsAhead(now: number = Date.now()): number {
    const mine = parse(this.file);
    if (mine === undefined) return 0;
    return live(this.directory, this.pool).filter(
      (other) => other.kind === "integration" && before(other, mine, now),
    ).length;
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
