/**
 * The places of one home, shared by every step of every thread and process.
 * The kernel runs each step in a fresh worker thread that loads the plugin
 * again, so a count kept in memory would start from zero in every step. The
 * counts live in one file under the home instead, changed under a lock file.
 * A place records the pid that holds it; a place whose process is gone (a
 * crashed serve) is dropped the next time anyone looks.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchDirectory, withLockFile } from "@operad-io/engine/platform";
import type { Claim, ClaimResult, Places } from "./places.ts";

/** How often a waiter looks again when no change was announced. */
const RECHECK_MS = 1000;

interface Held {
  readonly id: string;
  readonly pid: number;
  readonly keys: readonly string[];
}

interface Book {
  readonly version: number;
  readonly held: readonly Held[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBook(text: string): Book {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw.version !== "number" || !Array.isArray(raw.held)) {
      return { version: 0, held: [] };
    }
    const held: Held[] = [];
    for (const entry of raw.held) {
      if (
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.pid === "number" &&
        Array.isArray(entry.keys) &&
        entry.keys.every((key) => typeof key === "string")
      ) {
        held.push({ id: entry.id, pid: entry.pid, keys: entry.keys as string[] });
      }
    }
    return { version: raw.version, held };
  } catch {
    return { version: 0, held: [] };
  }
}

/** True when a process with this pid exists; sends no signal. */
function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export class FilePlaces implements Places {
  private readonly file: string;
  private readonly lock: string;
  private counter = 0;

  constructor(private readonly dir: string) {
    this.file = join(dir, "places.json");
    this.lock = join(dir, "places.lock");
  }

  private read(): Book {
    try {
      return parseBook(readFileSync(this.file, "utf8"));
    } catch {
      return { version: 0, held: [] };
    }
  }

  private write(book: Book): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${this.counter}.tmp`;
    writeFileSync(tmp, JSON.stringify(book));
    renameSync(tmp, this.file);
  }

  private quiet<T>(work: () => T): Promise<T> {
    return withLockFile(this.lock, work, { onLog: () => undefined, label: "pool places" });
  }

  /** The book without the places of dead processes. */
  private live(): Book {
    const book = this.read();
    const held = book.held.filter((entry) => alive(entry.pid));
    return held.length === book.held.length ? book : { version: book.version + 1, held };
  }

  claim(claims: readonly Claim[]): Promise<ClaimResult> {
    return this.quiet((): ClaimResult => {
      const book = this.live();
      const used = (key: string): number =>
        book.held.filter((entry) => entry.keys.includes(key)).length;
      const full: ("flow" | "home")[] = [];
      for (const [index, claim] of claims.entries()) {
        if (used(claim.own) >= claim.ownLimit) {
          full.push("flow");
        } else if (claim.homeLimit !== undefined && used(claim.home) >= claim.homeLimit) {
          full.push("home");
        } else {
          this.counter += 1;
          const id = `${process.pid}-${Date.now()}-${this.counter}`;
          this.write({
            version: book.version + 1,
            held: [...book.held, { id, pid: process.pid, keys: [claim.own, claim.home] }],
          });
          return { kind: "taken", index, release: () => this.release(id) };
        }
      }
      return { kind: "blocked", full, stamp: book.version };
    });
  }

  private release(id: string): Promise<void> {
    return this.quiet(() => {
      const book = this.read();
      this.write({
        version: book.version + 1,
        held: book.held.filter((entry) => entry.id !== id),
      });
    });
  }

  changed(since: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.read().version !== since) return Promise.resolve(true);
    mkdirSync(this.dir, { recursive: true });
    return new Promise((resolve) => {
      const stop = watchDirectory(this.dir, () => {
        if (this.read().version !== since) done(true);
      });
      const timer = setInterval(() => {
        // A holder that died never announces; look again.
        done(true);
      }, RECHECK_MS);
      const onAbort = (): void => done(false);
      const done = (value: boolean): void => {
        stop();
        clearInterval(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // A change between the first read and the watcher is not missed.
      if (this.read().version !== since) done(true);
    });
  }
}
