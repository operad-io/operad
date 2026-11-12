/** The person's key overrides: `$OPERAD_HOME/keys.json`, same shape as a plugin's `keys`. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { messageOf, PluginError } from "./errors.ts";
import type { KeyBindings } from "./types.ts";
import { isRecord } from "../util.ts";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The path of the key overrides for an operad home. */
export function keysPathFor(home: string): string {
  return join(home, "keys.json");
}

/** Reads `~/.operad/keys.json`; a missing file means no overrides. */
export async function readKeysFile(path: string): Promise<KeyBindings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return {};
    throw new PluginError(`key bindings "${path}": ${messageOf(error)}`, {
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PluginError(
      `key bindings "${path}": invalid JSON: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new PluginError(`key bindings "${path}": must be a JSON object`);
  }

  const keys: Record<string, string> = {};
  for (const [key, target] of Object.entries(raw)) {
    if (key.trim().length === 0) {
      throw new PluginError(
        `key bindings "${path}": a key must be a non-empty string`,
      );
    }
    if (typeof target !== "string" || target.trim().length === 0) {
      throw new PluginError(
        `key bindings "${path}": ${key}: must name an action as "<plugin>:<action>"`,
      );
    }
    keys[key] = target;
  }
  return keys;
}
