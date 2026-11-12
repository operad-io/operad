import { afterAll, describe, expect, test } from "bun:test";
import { git, headOf } from "../../src/steps.ts";
import { GitTimeoutError, printsOnSuccess } from "../../src/git.ts";
import { gitOrThrow, hangingGit, silentGit } from "../git-support.ts";
import { cleanupTempRoots, makeGitRepository, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

describe("git that exits 0 and prints nothing", () => {
  test("headOf returns the commit after empty answers", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "repo");
    const commit = gitOrThrow(path, ["rev-parse", "HEAD"]);
    const stub = silentGit(root, "rev-parse HEAD", 2);
    try {
      expect(headOf(path)).toBe(commit);
      expect(stub.calls()).toBe(3);
    } finally {
      stub.restore();
    }
  });

  test("a query that never prints fails with git's words and says it was empty", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "repo");
    const stub = silentGit(root, "rev-parse HEAD", 100);
    try {
      const result = git(path, ["rev-parse", "HEAD"]);
      expect(result.ok).toBe(false);
      expect(result.err).toContain("output was empty");
      expect(stub.calls()).toBe(5);
      expect(headOf(path)).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  test("a query allowed to print nothing is run once", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "repo");
    const stub = silentGit(root, "status", 100);
    try {
      const result = git(path, ["status", "--porcelain"]);
      expect(result).toEqual({ ok: true, out: "", err: "" });
      expect(stub.calls()).toBe(1);
    } finally {
      stub.restore();
    }
  });

  test("a repository with no remote is not asked five times", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "repo");
    const stub = silentGit(root, "remote", 100);
    try {
      expect(git(path, ["remote"])).toEqual({ ok: true, out: "", err: "" });
      expect(stub.calls()).toBe(1);
    } finally {
      stub.restore();
    }
  });

  test("the queries whose output is expected include the ones outside service.ts", () => {
    expect(printsOnSuccess(["remote", "get-url", "origin"])).toBe(true);
    expect(printsOnSuccess(["remote"])).toBe(false);
    expect(printsOnSuccess(["ls-remote", "--heads", "origin", "main"])).toBe(true);
    expect(printsOnSuccess(["patch-id", "--stable"])).toBe(true);
    expect(printsOnSuccess(["check-attr", "--stdin"])).toBe(true);
  });
});

describe("a git that never exits", () => {
  test("is killed at its limit and the error names the command, the directory and the time", async () => {
    const root = await tempRoot();
    const path = await makeGitRepository(root, "repo");
    const stub = hangingGit(root, "rev-parse HEAD");
    try {
      let caught: unknown;
      try {
        git(path, ["rev-parse", "HEAD"], { timeoutMs: 300 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitTimeoutError);
      const message = caught instanceof Error ? caught.message : "";
      expect(message).toContain("git rev-parse HEAD");
      expect(message).toContain(path);
      expect(message).toMatch(/did not end after \d+ ms and was killed/);
      expect(caught instanceof GitTimeoutError ? caught.ranMs : 0).toBeGreaterThanOrEqual(300);
      // A query that is not stuck still answers.
      expect(git(path, ["rev-parse", "--git-dir"], { timeoutMs: 300 }).ok).toBe(true);
    } finally {
      stub.restore();
    }
  });
});
