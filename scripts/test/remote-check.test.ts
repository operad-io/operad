import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "remote-check.sh");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * An origin with one commit on main, a local clone with one more commit (not
 * on origin), and a fake host: a home directory holding a clone of origin at
 * Code/operad, reached through fake ssh and scp scripts.
 */
function setup(): { root: string; local: string; home: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "remote-check-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  mkdirSync(join(seed, "scripts"));
  writeFileSync(join(seed, "scripts", "remote-check.sh"), readFileSync(script));
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "base");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const local = join(root, "local");
  git(root, "clone", "-q", origin, local);
  writeFileSync(join(local, "change.txt"), "change\n");
  git(local, "add", ".");
  git(local, "commit", "-q", "-m", "change");
  const home = join(root, "home");
  mkdirSync(join(home, "Code"), { recursive: true });
  git(root, "clone", "-q", origin, join(home, "Code", "operad"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "fake-ssh"), `#!/bin/bash\nshift\nHOME='${home}' exec bash -c "$1"\n`);
  writeFileSync(
    join(bin, "fake-scp"),
    `#!/bin/bash\n[ -z "$FAKE_SCP_FAIL" ] || exit 1\ncp "$1" '${home}'/"\${2#*:}"\n`,
  );
  chmodSync(join(bin, "fake-ssh"), 0o755);
  chmodSync(join(bin, "fake-scp"), 0o755);
  return {
    root,
    local,
    home,
    env: {
      OPERAD_CHECK_HOST: "fake",
      OPERAD_CHECK_SSH: join(bin, "fake-ssh"),
      OPERAD_CHECK_SCP: join(bin, "fake-scp"),
      OPERAD_CHECK_PATH: "/nonexistent",
    },
  };
}

async function run(local: string, env: Record<string, string>, command: string) {
  const child = Bun.spawn(["bash", join(local, "scripts", "remote-check.sh"), command], {
    cwd: local,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

/** Waits until a writer opens the fifo and writes a line to it. */
async function readFifo(path: string): Promise<void> {
  await Bun.spawn(["cat", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
}

describe("remote-check.sh", () => {
  test("without a host it runs the command here", async () => {
    const { local } = setup();
    const result = await run(local, { OPERAD_CHECK_HOST: "" }, "pwd; exit 4");
    expect(result.code).toBe(4);
    expect(realpathSync(result.out.trim())).toBe(realpathSync(local));
  });

  test("on the host it checks out exactly HEAD and returns the command's exit code", async () => {
    const { local, home, env } = setup();
    const result = await run(local, env, "git rev-parse HEAD; cat change.txt; exit 3");
    expect(result.code).toBe(3);
    expect(result.out).toContain(git(local, "rev-parse", "HEAD"));
    expect(result.out).toContain("change");
    // The copied bundle is removed afterwards.
    expect(spawnSync("ls", [home], { encoding: "utf8" }).stdout).not.toContain(".bundle");
  });

  test("a package directory left from an earlier commit is removed, root node_modules is kept", async () => {
    const { local, home, env } = setup();
    const tree = join(home, "Code", "operad");
    mkdirSync(join(tree, "packages", "gone", "node_modules", "x"), { recursive: true });
    mkdirSync(join(tree, "node_modules", "kept"), { recursive: true });
    const result = await run(local, env, "ls packages 2>/dev/null; echo ---; ls node_modules");
    expect(result.code).toBe(0);
    const [packages = "", modules = ""] = result.out.split("---");
    expect(packages).not.toContain("gone");
    expect(modules).toContain("kept");
  });

  test("a failed copy exits 1 and names the step", async () => {
    const { local, env } = setup();
    const result = await run(local, { ...env, FAKE_SCP_FAIL: "1" }, "true");
    expect(result.code).toBe(1);
    expect(result.err).toContain("remote-check: copy to fake failed");
  });

  test("two checks on one host take the lock in turn", async () => {
    const { root, local, env } = setup();
    const started = join(root, "first-started");
    const release = join(root, "release");
    const ended = join(root, "first-ended");
    const seen = join(root, "second-saw");
    spawnSync("mkfifo", [started, release]);
    const first = run(
      local,
      env,
      `echo started > '${started}'; read -r _ < '${release}'; touch '${ended}'`,
    );
    try {
      await readFifo(started);
      const second = run(local, env, `if [ -f '${ended}' ]; then echo after > '${seen}'; else echo during > '${seen}'; fi`);
      await Bun.spawn(["sh", "-c", `echo go > '${release}'`], { stdin: "ignore" }).exited;
      expect((await first).code).toBe(0);
      expect((await second).code).toBe(0);
      expect(readFileSync(seen, "utf8").trim()).toBe("after");
    } finally {
      // A test that fails before the release must not leave the first check
      // waiting on the fifo for ever. Opening it read-write never blocks, and a
      // line nobody reads is dropped with the fifo.
      await Bun.spawn(["sh", "-c", `exec 3<>'${release}'; echo go >&3`], { stdin: "ignore" }).exited;
      await first;
    }
  });
});
