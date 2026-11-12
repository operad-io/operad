/**
 * Flows a plugin generated while a process ran. They are kept beside the
 * plugin store so the run's own process loads the same graph: a declaration
 * exists only in the memory of the process that made it.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FlowDefinition } from "../flow/types.ts";
import { isRecord } from "../util.ts";

/** One flow a plugin declared, with the plugin that made it. */
export interface StoredDeclaredFlow {
  readonly plugin: string;
  readonly flow: FlowDefinition;
}

const DIRECTORY = "flows";

function directoryOf(root: string): string {
  return join(root, DIRECTORY);
}

function fileOf(root: string, name: string): string {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 32);
  return join(directoryOf(root), `${hash}.json`);
}

/** Keeps a declaration for a later process; a write lands whole or not at all. */
export function writeDeclaredFlow(
  root: string,
  plugin: string,
  flow: FlowDefinition,
): void {
  const file = fileOf(root, flow.name);
  const directory = directoryOf(root);
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const record: StoredDeclaredFlow = { plugin, flow };
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf8");
  renameSync(temporary, file);
}

/** Every declaration kept under the store root. A torn file says nothing. */
export function readDeclaredFlows(root: string): readonly StoredDeclaredFlow[] {
  let names: string[];
  try {
    names = readdirSync(directoryOf(root)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const flows: StoredDeclaredFlow[] = [];
  for (const name of names) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(directoryOf(root), name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.plugin !== "string" || !isRecord(value.flow)) {
      continue;
    }
    if (typeof value.flow.name !== "string" || value.flow.name.length === 0) continue;
    flows.push(value as unknown as StoredDeclaredFlow);
  }
  return flows;
}
