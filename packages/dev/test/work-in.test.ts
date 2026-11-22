import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevError } from "../src/model.ts";
import {
  DEFAULT_DEV_SETTINGS,
  repositoryTaskCap,
  settingsValueProblem,
  validateDevSettings,
} from "../src/settings.ts";

function refusal(value: unknown): string {
  try {
    validateDevSettings(value);
  } catch (error) {
    if (error instanceof DevError) return error.message;
    throw error;
  }
  throw new Error("the settings were accepted");
}

describe("dev.json workIn", () => {
  test("a repository that does not set it works in a worktree", () => {
    expect(DEFAULT_DEV_SETTINGS.workIn).toBe("worktree");
    expect(validateDevSettings({}).workIn).toBe("worktree");
    expect(validateDevSettings({ workIn: "worktree", concurrency: 3 }).workIn).toBe("worktree");
  });

  test("only branch and worktree are accepted", () => {
    expect(validateDevSettings({ workIn: "branch" }).workIn).toBe("branch");
    expect(refusal({ workIn: "folder" })).toContain('workIn: must be "branch" or "worktree"');
  });

  test("branch with concurrency above 1 is refused, naming what to change", () => {
    const message = refusal({ workIn: "branch", concurrency: 2 });
    expect(message).toContain("concurrency");
    expect(message).toContain('workIn to "worktree"');
    expect(validateDevSettings({ workIn: "branch", concurrency: 1 }).workIn).toBe("branch");
  });

  test("branch with workers that add up to more than 1 in a pool is refused", () => {
    const message = refusal({
      workIn: "branch",
      workers: { a: { use: "claude/agent", count: 2 } },
    });
    expect(message).toContain('pool "default"');
    expect(message).toContain("counts");
    refusal({
      workIn: "branch",
      workers: { a: { use: "claude/agent" }, b: { use: "pi/agent" } },
    });
    const single = validateDevSettings({
      workIn: "branch",
      workers: { a: { use: "claude/agent" }, b: { use: "pi/agent" } },
      pools: { default: ["a"], two: ["b"] },
    });
    expect(single.workIn).toBe("branch");
  });

  test("repositoryTaskCap is 1 for branch whatever the pools say", () => {
    const worktree = validateDevSettings({
      workers: { a: { use: "claude/agent" }, b: { use: "pi/agent" } },
      pools: { default: ["a"], two: ["b"] },
    });
    expect(repositoryTaskCap(worktree)).toBe(2);
    expect(repositoryTaskCap({ ...worktree, workIn: "branch" })).toBe(1);
  });

  test("a save that the load would refuse is refused", () => {
    const repository = mkdtempSync(join(tmpdir(), "work-in-"));
    expect(settingsValueProblem(repository, { workIn: "branch", concurrency: 2 })).toContain("concurrency");
    expect(settingsValueProblem(repository, { workIn: "branch" })).toBeUndefined();
  });
});
