/**
 * The host's side of a one-time permission. A harness program that is about to
 * run a call its access profile refuses writes one `grant_use` line and waits
 * for one `grant_ack` line on its stdin; the host records the use and answers.
 * `pi` and `claude` share this.
 */

/** Whether the run's access profile holds a permission the program may ask to use. */
export function hasGrants(access: unknown): boolean {
  if (typeof access !== "object" || access === null || Array.isArray(access)) return false;
  const grants: unknown = Reflect.get(access, "grants");
  return Array.isArray(grants) && grants.length > 0;
}

/** The `grant_use` line the program writes before a granted call, if this is one. */
export function grantUse(line: string): { readonly id: number; readonly waitId: string } | undefined {
  if (!line.includes('"grant_use"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const type: unknown = Reflect.get(parsed, "type");
    const id: unknown = Reflect.get(parsed, "id");
    const waitId: unknown = Reflect.get(parsed, "waitId");
    if (type === "grant_use" && typeof id === "number" && typeof waitId === "string") {
      return { id, waitId };
    }
  } catch {
    // Not JSON: an ordinary line.
  }
  return undefined;
}

/**
 * Answers a `grant_use` line: asks the host to use the permission up and
 * writes the `grant_ack` line with the outcome. `used` is true only when the
 * host recorded the use; a host that throws answers `used: false`. Any other
 * line is left alone.
 */
export async function answerGrant(
  line: string,
  useGrant: (waitId: string) => Promise<boolean>,
  reply: (text: string) => void,
): Promise<void> {
  const use = grantUse(line);
  if (use === undefined) return;
  let used = false;
  try {
    used = await useGrant(use.waitId);
  } catch {
    used = false;
  }
  reply(JSON.stringify({ type: "grant_ack", id: use.id, used }));
}
