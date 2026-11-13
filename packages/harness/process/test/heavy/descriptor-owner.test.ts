import { describe, expect, test } from "bun:test";

const FIXTURE = new URL("../fixtures/descriptor-owner.ts", import.meta.url).pathname;

describe("harness process descriptors", () => {
  test("running 30 harness commands next to open databases never closes a descriptor twice", async () => {
    // A double close on a SQLite descriptor ends the process with SIGKILL, so
    // the check runs in a child process and reads how it ended.
    const child = Bun.spawn({
      cmd: [process.execPath, FIXTURE, "30"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ rounds: 30, tails: ["oops"] });
  }, 120_000);
});
