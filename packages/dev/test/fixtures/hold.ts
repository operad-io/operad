/**
 * Shell text for a test fixture that blocks until a line arrives on a fifo, and
 * that cannot outlive its owner or `lifetimeSecs` seconds.
 *
 * It is POSIX sh, because a key command runs under `sh -c` and `/bin/sh` is
 * dash on the check host: the shell opens the fifo read-write (that never
 * blocks) and `read`s it, so the wait is on the fifo's line itself. A watcher in
 * the background ends the wait by writing a line of its own when the owner
 * process is gone, or when the lifetime is past. So a test killed before its
 * `finally` runs leaves no shell waiting for ever, and a reused or zombie owner
 * pid is only a delay: the lifetime is the last backstop. A passing test ends
 * the wait by writing the release line, never by the watcher.
 */
export const HOLD_LIFETIME_SECS = 600;

export function holdUntilReleased(
  release: string,
  owner: number = process.pid,
  lifetimeSecs: number = HOLD_LIFETIME_SECS,
): string {
  return (
    `exec 3<>'${release}'; ` +
    `(` +
    `i=0; ` +
    `while [ "$i" -lt ${lifetimeSecs} ]; do ` +
    `sleep 1; ` +
    `i=$((i + 1)); ` +
    `kill -0 ${owner} 2>/dev/null || { echo hold: owner gone >&2; echo owner-gone >&3; exit 0; }; ` +
    `done; ` +
    `echo hold: lifetime >&2; echo lifetime >&3` +
    `) & ` +
    `watcher=$!; ` +
    `read -r _ <&3; ` +
    `kill "$watcher" 2>/dev/null || true`
  );
}
