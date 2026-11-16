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

/** The directory a plugin's runs write their step logs in: `<store>/logs/<plugin>/runs`. */
function runLogsDirectory(storeRoot: string, plugin: string): string {
  return join(storeRoot, "logs", segment(plugin), "runs");
}

/** One run's step-log directory: `<store>/logs/<plugin>/runs/<run>`. */
export function runLogDirectory(
  storeRoot: string,
  plugin: string,
  runId: string,
): string {
  return join(runLogsDirectory(storeRoot, plugin), segment(runId));
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
