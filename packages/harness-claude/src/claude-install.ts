/** Finding the user's own `claude`: operad bundles no Claude Code. */

import { realpathSync } from "node:fs";

export class ClaudeNotFoundError extends Error {
  constructor(command: string) {
    super(
      `no \`${command}\` command was found; install Claude Code first (https://code.claude.com) or set the command setting to its path`,
    );
    this.name = "ClaudeNotFoundError";
  }
}

/**
 * The real path of the claude command: a name looked up on `path`, or a path.
 * Throws `ClaudeNotFoundError` when there is none.
 */
export function findClaude(command: string | undefined, path: string | undefined = process.env.PATH): string {
  const wanted = command ?? "claude";
  const found = wanted.includes("/") ? Bun.which(wanted) : Bun.which(wanted, { PATH: path ?? "" });
  if (found === null) throw new ClaudeNotFoundError(wanted);
  return realpathSync(found);
}
