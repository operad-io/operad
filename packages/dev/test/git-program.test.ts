import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";

test("git() returns a result and does not throw when PATH has no git", () => {
  const dir = mkdtempSync(join(tmpdir(), "nogit-dev-"));
  const result = git(dir, ["--version"], { env: { PATH: dir } });
  // A machine that keeps git in a usual place outside PATH still finds it;
  // without one the answer is the plain refusal and nothing was spawned.
  if (!result.ok) expect(result.err).toBe("git is not installed");
});
