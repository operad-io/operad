import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A regression test for the input-index rebuild. The child appends a whole
 * `inputs.jsonl` record immediately after the rebuild has read the file, so the
 * rebuild must count the bytes it consumed rather than a later `statSync`.
 * The child runs in its own process so its module mock stays out of the suite.
 */
const FIXTURE = join(import.meta.dir, "fixtures", "input-rebuild-child.ts");
const TEST_ROOT = resolve(import.meta.dir, "..", "..", "..", ".radian", "test-tmp");

interface ChildResult {
  readonly appendedId: string;
  readonly duplicate: boolean;
  readonly inputId: string;
  readonly records: number;
}

async function runFixture(directory: string): Promise<ChildResult> {
  const proc = Bun.spawn([process.execPath, FIXTURE, directory], {
    cwd: TEST_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, line, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0 || line.length === 0) {
    throw new Error(`input-rebuild child exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(line) as ChildResult;
}

test("opening a store does not miss an input appended during the rebuild", async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = join(TEST_ROOT, `input-rebuild-${randomUUID()}`);
  try {
    const result = await runFixture(directory);
    expect(result.duplicate).toBe(true);
    expect(result.inputId).toBe(result.appendedId);
    expect(result.records).toBe(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

