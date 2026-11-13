import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateMainClone, type CommandRunner } from "../../src/mainclone.ts";

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

/** A clone on main with a commit `target` on branch next, one ahead. */
function scratch(): { dir: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), "mainclone-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a"), "one\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "one");
  sh(dir, "checkout", "-q", "-b", "next");
  writeFileSync(join(dir, "a"), "two\n");
  sh(dir, "commit", "-q", "-am", "two");
  const target = sh(dir, "rev-parse", "HEAD");
  sh(dir, "checkout", "-q", "main");
  return { dir, target };
}

function recorder(ok: (line: string) => boolean = () => true) {
  const calls: { cwd: string; line: string }[] = [];
  const run: CommandRunner = async (cwd, line) => {
    calls.push({ cwd, line });
    return ok(line) ? { ok: true, out: "" } : { ok: false, out: "x\nlast words\n" };
  };
  return { calls, run };
}

test("a fast-forwarded clone runs each prepare line in order in the clone", async () => {
  const { dir, target } = scratch();
  const { calls, run } = recorder();
  const outcome = await updateMainClone(dir, "main", target, ["one", "two"], run);
  expect(sh(dir, "rev-parse", "HEAD")).toBe(target);
  expect(calls).toEqual([
    { cwd: dir, line: "one" },
    { cwd: dir, line: "two" },
  ]);
  expect(outcome).toMatchObject({ updated: true, prepared: true });
});

test("no prepare lines run no command", async () => {
  const { dir, target } = scratch();
  const { calls, run } = recorder();
  expect(await updateMainClone(dir, "main", target, [], run)).toEqual({ updated: true });
  expect(calls).toEqual([]);
});

test("a clone that did not move runs nothing", async () => {
  const { dir, target } = scratch();
  const { calls, run } = recorder();
  await updateMainClone(dir, "main", target, ["one"], run);
  calls.length = 0;
  expect(await updateMainClone(dir, "main", target, ["one"], run)).toEqual({ updated: true });
  expect(calls).toEqual([]);
});

test("a failing line gives the note, stops the rest and keeps the fast-forward", async () => {
  const { dir, target } = scratch();
  const { calls, run } = recorder((line) => line !== "bad");
  const outcome = await updateMainClone(dir, "main", target, ["bad", "after"], run);
  expect(sh(dir, "rev-parse", "HEAD")).toBe(target);
  expect(calls.map((call) => call.line)).toEqual(["bad"]);
  expect(outcome).toEqual({
    updated: true,
    prepared: false,
    note: "prepare failed: bad: last words",
  });
});

test("a dirty clone is left alone and runs nothing", async () => {
  const { dir, target } = scratch();
  const before = sh(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a"), "dirty\n");
  const { calls, run } = recorder();
  const outcome = await updateMainClone(dir, "main", target, ["one"], run);
  expect(outcome.updated).toBe(false);
  expect(sh(dir, "rev-parse", "HEAD")).toBe(before);
  expect(calls).toEqual([]);
});
