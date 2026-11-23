import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findGit,
  GIT_NOT_INSTALLED,
  realGitFinderHost,
  type GitFinderHost,
} from "../../src/platform/git-program.ts";

interface Fake {
  readonly platform?: NodeJS.Platform;
  readonly env?: Record<string, string | undefined>;
  readonly onPath?: string | null;
  readonly files?: readonly string[];
  readonly xcode?: { code: number; out: string };
}

function fakeHost(fake: Fake): { host: GitFinderHost; runs: string[][] } {
  const runs: string[][] = [];
  const files = new Set(fake.files ?? []);
  return {
    runs,
    host: {
      platform: fake.platform ?? "linux",
      env: fake.env ?? { PATH: "/bin" },
      which: () => fake.onPath ?? null,
      exists: (path) => files.has(path),
      run: (cmd) => {
        runs.push([...cmd]);
        return fake.xcode ?? { code: 2, out: "" };
      },
    },
  };
}

const HOMEBREW = "/opt/homebrew/bin/git";
const STUB = "/usr/bin/git";
const TOOLS = "/Library/Developer/CommandLineTools";

describe("findGit", () => {
  test("a PATH without git finds none, on a real scan", () => {
    const empty = mkdtempSync(join(tmpdir(), "nogit-"));
    const found = findGit({
      ...realGitFinderHost(),
      platform: "linux",
      env: { PATH: empty },
    });
    expect(found).toBeUndefined();
    expect(GIT_NOT_INSTALLED).toBe("git is not installed");
  });

  test("a git program put on PATH later is found on the next call", () => {
    const dir = mkdtempSync(join(tmpdir(), "late-git-"));
    const probe = () =>
      findGit({ ...realGitFinderHost(), platform: "linux", env: { PATH: dir } });
    expect(probe()).toBeUndefined();
    const program = join(dir, "git");
    writeFileSync(program, "#!/bin/sh\nexit 0\n");
    chmodSync(program, 0o755);
    expect(probe()).toBe(program);
  });

  test("Linux returns the PATH answer and runs nothing", () => {
    const { host, runs } = fakeHost({ onPath: STUB });
    expect(findGit(host)).toBe(STUB);
    expect(runs).toEqual([]);
  });

  test("macOS: a Homebrew git on PATH is trusted without xcode-select", () => {
    const { host, runs } = fakeHost({ platform: "darwin", onPath: HOMEBREW });
    expect(findGit(host)).toBe(HOMEBREW);
    expect(runs).toEqual([]);
  });

  test("macOS: a short PATH still finds Homebrew by its usual place", () => {
    const { host } = fakeHost({ platform: "darwin", onPath: null, files: [HOMEBREW] });
    expect(findGit(host)).toBe(HOMEBREW);
  });

  test("macOS: the stub is refused when xcode-select -p fails", () => {
    const { host, runs } = fakeHost({
      platform: "darwin",
      onPath: STUB,
      files: [STUB],
      xcode: { code: 2, out: "" },
    });
    expect(findGit(host)).toBeUndefined();
    expect(runs).toEqual([["/usr/bin/xcode-select", "-p"]]);
  });

  test("macOS: the stub is trusted when the selected directory holds a git", () => {
    const { host } = fakeHost({
      platform: "darwin",
      onPath: STUB,
      files: [`${TOOLS}/usr/bin/git`],
      xcode: { code: 0, out: TOOLS },
    });
    expect(findGit(host)).toBe(STUB);
  });

  test("macOS: a selected directory with no git in it is refused", () => {
    const { host } = fakeHost({
      platform: "darwin",
      onPath: STUB,
      xcode: { code: 0, out: TOOLS },
    });
    expect(findGit(host)).toBeUndefined();
  });

  test("macOS: xcode-select runs by absolute path, so a fake earlier on PATH is not used", () => {
    const { host, runs } = fakeHost({
      platform: "darwin",
      env: { PATH: "/tmp/fake-bin" },
      onPath: STUB,
      xcode: { code: 2, out: "" },
    });
    expect(findGit(host)).toBeUndefined();
    expect(runs[0]?.[0]).toBe("/usr/bin/xcode-select");
  });

  test("Windows: the usual places are looked at when PATH has no git", () => {
    const program = join("C:\\Program Files", "Git", "cmd", "git.exe");
    const { host } = fakeHost({
      platform: "win32",
      env: { PATH: "", ProgramFiles: "C:\\Program Files" },
      onPath: null,
      files: [program],
    });
    expect(findGit(host)).toBe(program);
  });

  test("Windows: nothing on PATH and nowhere else is not installed", () => {
    const { host } = fakeHost({ platform: "win32", env: { PATH: "" }, onPath: null });
    expect(findGit(host)).toBeUndefined();
  });
});
