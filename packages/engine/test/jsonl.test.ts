import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openJsonlLogBackend } from "../src/index.ts";
import { runLogConformance, type LogConformanceFactory } from "./log-conformance.ts";

const schemaPath = (directory: string): string => join(directory, "schema.json");
const inputsPath = (directory: string): string => join(directory, "inputs.jsonl");
const runPath = (directory: string, runId: string): string =>
  join(directory, "runs", `${runId}.jsonl`);

const factory: LogConformanceFactory = {
  name: "jsonl",
  modulePath: new URL("../src/log/jsonl.ts", import.meta.url).href,
  open: (directory, options) => openJsonlLogBackend(directory, options),
  readSchemaVersion(directory) {
    const path = schemaPath(directory);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as { schema_version?: unknown };
    return typeof value.schema_version === "number" ? value.schema_version : undefined;
  },
  writeSchemaVersion(directory, version) {
    writeFileSync(schemaPath(directory), `${JSON.stringify({ schema_version: version })}\n`);
  },
  removeRun(directory, runId) {
    rmSync(runPath(directory, runId), { force: true });
  },
  countInputRecords(directory) {
    const path = inputsPath(directory);
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
  },
  storedText(directory, runId) {
    return readFileSync(runPath(directory, runId), "utf8");
  },
  rawRun: {
    size: (directory, runId) => statSync(runPath(directory, runId)).size,
    append(directory, runId, text) {
      appendFileSync(runPath(directory, runId), text);
    },
  },
};

runLogConformance(factory);
