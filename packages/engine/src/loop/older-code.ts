/**
 * The notice that serve runs older code than the files on disk.
 *
 * The code watch knows when the files differ from what serve loaded. When it
 * keeps the old code (the new files do not load, or serve could not hand over),
 * serve leaves a small file in the home naming its process; the pending view
 * shows one item while that process still holds the serve lock. A restarted
 * serve is another process, so the item leaves with it.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, readLockPid, serveLockPath } from "../runner/lock.ts";

function noticePath(home: string): string {
  return join(home, "serve-older.json");
}

/** What the pending view shows; the id is the same item each time. */
export const OLDER_CODE_ITEM_ID = "serve-older";

export const OLDER_CODE_PROMPT =
  "serve runs older code than the files on disk: restart serve to load them (operad serve stop, then operad serve)";

/** Records, for the serve of this process, whether its code is older than the disk. */
export function olderCodeNotice(home: string, pid: number = process.pid): {
  readonly report: (older: boolean) => void;
  readonly clear: () => void;
} {
  const clear = (): void => rmSync(noticePath(home), { force: true });
  return {
    report: (older) => {
      if (!older) {
        clear();
        return;
      }
      const temporary = `${noticePath(home)}.${pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ pid })}\n`);
      renameSync(temporary, noticePath(home));
    },
    clear,
  };
}

/** True when the serve that holds the home's lock reported older code. */
export function servesOlderCode(home: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(noticePath(home), "utf8"));
    const pid =
      typeof raw === "object" && raw !== null && "pid" in raw
        ? (raw as { pid?: unknown }).pid
        : undefined;
    if (typeof pid !== "number") return false;
    return readLockPid(serveLockPath(home)) === pid && pidAlive(pid);
  } catch {
    return false;
  }
}
