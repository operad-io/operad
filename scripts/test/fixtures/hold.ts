/**
 * Shell text for a test fixture that blocks until a line arrives on a fifo, and
 * that cannot outlive its owner.
 *
 * The shell opens the fifo read-write (that never blocks) and reads with a one
 * second bound. Each time the bound passes it checks that the owner process is
 * still alive and ends if not. So a test killed before its `finally` runs
 * leaves no shell waiting for ever. A passing test ends the wait by writing the
 * release line, never by the bound.
 */
export function holdUntilReleased(release: string, owner: number = process.pid): string {
  return `exec 3<>'${release}'; until read -r -t 1 -u 3 _; do kill -0 ${owner} 2>/dev/null || exit 0; done`;
}
