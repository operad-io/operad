import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginLogger } from "./types.ts";

/** Keeps a name usable as one path segment. */
function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length === 0 || cleaned === "." || cleaned === ".."
    ? "_"
    : cleaned;
}

/**
 * A logger for one step, action, command or tick. It appends to a file under
 * `<store>/logs` and returns that path so the plugin can put it in a fact.
 */
export function createPluginLogger(
  storeRoot: string,
  ...segments: readonly string[]
): PluginLogger {
  const path = `${join(storeRoot, "logs", ...segments.map(segment))}.log`;
  return {
    path,
    async write(text: string): Promise<string> {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      return path;
    },
  };
}
