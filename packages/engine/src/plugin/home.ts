import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The operad home: `$OPERAD_HOME`, or `~/.operad`. The kernel keeps its
 * config, store and loop here and assumes no repository.
 */
export function defaultOperadHome(): string {
  const fromEnv = process.env.OPERAD_HOME;
  return fromEnv !== undefined && fromEnv.trim().length > 0
    ? resolve(fromEnv)
    : resolve(homedir(), ".operad");
}
