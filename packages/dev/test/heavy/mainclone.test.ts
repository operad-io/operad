import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateMainClone } from "../../src/mainclone.ts";

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

test("a kill between the fast-forward and the install is repaired by the rerun", () => {
  const dir = mkdtempSync(join(tmpdir(), "mainclone-"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "bun.lock"), "one\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "one");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "ignore");
  sh(dir, "checkout", "-q", "-b", "next");
  writeFileSync(join(dir, "bun.lock"), "two\n");
  sh(dir, "commit", "-q", "-am", "two");
  const target = sh(dir, "rev-parse", "HEAD");
  sh(dir, "checkout", "-q", "main");

  expect(() =>
    updateMainClone(dir, "main", target, () => {
      throw new Error("killed");
    }),
  ).toThrow("killed");
  expect(sh(dir, "rev-parse", "HEAD")).toBe(target);

  const calls: string[][] = [];
  const outcome = updateMainClone(dir, "main", target, (_cwd, cmd) => {
    calls.push([...cmd]);
    return { ok: true, out: "" };
  });
  expect(calls).toEqual([["bun", "install", "--frozen-lockfile"]]);
  expect(outcome).toMatchObject({ updated: true, installed: true });

  // Installed now: a further rerun installs nothing.
  const again = updateMainClone(dir, "main", target, () => {
    throw new Error("no install expected");
  });
  expect(again).toEqual({ updated: true });
});
