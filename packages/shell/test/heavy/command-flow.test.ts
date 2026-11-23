import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fakeClock, runFlow } from "@operad-io/engine/testing";
import { createShellPlugin } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

function stepResult(facts: readonly { kind: string; payload: unknown }[]): Record<string, unknown> {
  const fact = facts.find((entry) => entry.kind === "step_result");
  return (fact?.payload ?? {}) as Record<string, unknown>;
}

async function start(params: Record<string, unknown>) {
  return runFlow(createShellPlugin({ clock: fakeClock(0) }), "shell:command", {
    inProcess: true,
    clock: fakeClock(0),
    params: params as never,
  });
}

describe("the shell:command flow", () => {
  test("runs the command line in the given directory and records its output", async () => {
    const dir = await tempRoot();
    const run = await start({ command: "basename \"$PWD\"; echo done-line", cwd: dir });
    expect(run.end).toBe("done");
    const data = stepResult(run.facts).data as Record<string, unknown>;
    expect(data.exitCode).toBe(0);
    expect(data.tail).toContain("done-line");
    expect(data.tail).toContain(basename(dir));
    expect(readFileSync(String(data.log), "utf8")).toContain("done-line");
  });

  test("a non-zero exit ends the run failed, with the exit code and the output tail", async () => {
    const run = await start({ command: "echo boom; exit 3", cwd: await tempRoot() });
    expect(run.end).toBe("failed");
    const data = stepResult(run.facts).data as Record<string, unknown>;
    expect(data.exitCode).toBe(3);
    expect(data.message).toBe("the command exited 3");
    expect(data.tail).toContain("boom");
  });

  test("a directory that is not there fails the run and says so", async () => {
    const run = await start({ command: "true", cwd: "/no/such/dir-t0783" });
    expect(run.end).toBe("failed");
    expect((stepResult(run.facts).data as Record<string, unknown>).reason).toBe("cwd");
  });

  test("a missing command is refused", async () => {
    const run = await start({});
    expect(run.end).not.toBe("done");
  });
});
