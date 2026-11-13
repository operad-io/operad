import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles } from "../../src/steps.ts";
import { gitOrThrow } from "../git-support.ts";
import { cleanupTempRoots, makeGitRepository, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

/** A repository whose tracked files are committed, so the first status entry is the one under test. */
async function repository(files: readonly string[]): Promise<string> {
  const path = await makeGitRepository(await tempRoot());
  for (const file of files) writeFileSync(join(path, file), `${file}\n`);
  gitOrThrow(path, ["add", "."]);
  gitOrThrow(path, [...IDENTITY, "commit", "-qm", "files"]);
  return path;
}

describe("changedFiles", () => {
  test("a modified tracked file that comes first keeps its whole name", async () => {
    const path = await repository(["HELLO2.md"]);
    writeFileSync(join(path, "HELLO2.md"), "changed\n");
    expect(changedFiles(path)).toEqual(["HELLO2.md"]);
  });

  test("a modified file ahead of an untracked one, and a staged one, are whole", async () => {
    const path = await repository(["AAA.md", "BBB.md"]);
    writeFileSync(join(path, "AAA.md"), "changed\n");
    writeFileSync(join(path, "BBB.md"), "changed\n");
    gitOrThrow(path, ["add", "BBB.md"]);
    writeFileSync(join(path, "new.md"), "new\n");
    expect(changedFiles(path)).toEqual(["AAA.md", "BBB.md", "new.md"]);
  });

  test("a deleted file that comes first keeps its whole name", async () => {
    const path = await repository(["GONE.md"]);
    rmSync(join(path, "GONE.md"));
    expect(changedFiles(path)).toEqual(["GONE.md"]);
  });

  test("a rename reports the new path only, whole", async () => {
    const path = await repository(["OLD.md"]);
    gitOrThrow(path, ["mv", "OLD.md", "NEW.md"]);
    expect(changedFiles(path)).toEqual(["NEW.md"]);
  });

  test("a rename into a directory is not followed by its old path", async () => {
    const path = await repository(["OLD.md", "OTHER.md"]);
    mkdirSync(join(path, "dir"));
    renameSync(join(path, "OLD.md"), join(path, "dir", "MOVED.md"));
    gitOrThrow(path, ["add", "-A"]);
    writeFileSync(join(path, "OTHER.md"), "changed\n");
    expect(changedFiles(path)).toEqual(["OTHER.md", "dir/MOVED.md"]);
  });

  test("a name with spaces, quotes or non-ASCII letters comes back as written", async () => {
    const names = ["with space.md", 'quo"te.md', "héllo wörld.md"];
    const path = await repository(names);
    for (const name of names) writeFileSync(join(path, name), "changed\n");
    expect(changedFiles(path)).toEqual([...names].sort());
  });

  test("a rename of a name with a space reports the new name whole", async () => {
    const path = await repository(["old name.md"]);
    gitOrThrow(path, ["mv", "old name.md", "new name.md"]);
    expect(changedFiles(path)).toEqual(["new name.md"]);
  });

  test("a clean work tree has no changed file", async () => {
    expect(changedFiles(await repository(["A.md"]))).toEqual([]);
  });
});
