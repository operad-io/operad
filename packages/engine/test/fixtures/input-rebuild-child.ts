#!/usr/bin/env bun
/**
 * The input-index rebuild regression, in its own process so the module mock
 * cannot reach the conformance suite. It prints one JSON result on stdout.
 */
import { mock } from "bun:test";
import * as realFs from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { join } from "node:path";

let armed = false;
let inject = (): void => {};

mock.module("../../src/log/file-system.ts", () => ({
  ...realFs,
  openAsync,
  readFileSync: ((path: realFs.PathLike, options?: unknown) => {
    const result = (realFs.readFileSync as (p: realFs.PathLike, o?: unknown) => unknown)(
      path,
      options,
    );
    if (armed && String(path).endsWith("inputs.jsonl")) {
      armed = false;
      inject();
    }
    return result;
  }) as typeof realFs.readFileSync,
}));

const { openJsonlLogBackend } = await import("../../src/log/jsonl.ts");

function inputIdFor(source: string, sourceKey: string): string {
  return `input_${Buffer.from(JSON.stringify([source, sourceKey]), "utf8").toString("base64url")}`;
}

function countLines(path: string): number {
  return realFs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0).length;
}

const directory = process.argv[2];
if (directory === undefined) {
  throw new Error("missing the store directory argument");
}
realFs.mkdirSync(directory, { recursive: true });

const first = await openJsonlLogBackend(directory);
const run = await first.startRun("flow", "object");
const kept = await first.recordInput(run.runId, "github", "issue:1", { title: "one" });
if (kept.duplicate) throw new Error("the first input was already a duplicate");

const appendedId = inputIdFor("github", "issue:2");
inject = () => {
  const record = {
    type: "input",
    inputId: appendedId,
    runId: "ignored-by-dedupe",
    source: "github",
    sourceKey: "issue:2",
    payload: {},
    time: 1_700_000_000_000,
  };
  realFs.appendFileSync(join(directory, "inputs.jsonl"), `${JSON.stringify(record)}\n`);
};
armed = true;

const second = await openJsonlLogBackend(directory);
const duplicate = await second.recordInput(run.runId, "github", "issue:2", { title: "two" });

process.stdout.write(
  `${JSON.stringify({
    appendedId,
    duplicate: duplicate.duplicate,
    inputId: duplicate.inputId,
    records: countLines(join(directory, "inputs.jsonl")),
  })}\n`,
);

await second.close();
await first.close();
