import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { holdUntilReleased } from "./fixtures/hold.ts";
import { anchoredPattern, rerunCommand } from "../../packages/dev/src/rerun.ts";
import { alive, waitForGone } from "../../packages/engine/test/plugin/support.ts";

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

/**
 * The test process's environment without the OPERAD_CHECK_* settings. When the
 * suite itself runs inside a check on the host, remote-check.sh has exported
 * OPERAD_CHECK_SLOTS and OPERAD_CHECK_LANE=integration there; a test that does
 * not set them would otherwise take the integration slot and its tree.
 */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("OPERAD_CHECK_")) out[key] = value;
  }
  return out;
}

async function run(local: string, env: Record<string, string>, command: string, ...words: string[]) {
  const args = words.length > 0 ? ["--", command, ...words] : [command];
  const child = Bun.spawn(["bash", join(local, "scripts", "remote-check.sh"), ...args], {
    cwd: local,
    env: { ...cleanEnv(), ...env },
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
      `echo started > '${started}'; ${holdUntilReleased(release)}; touch '${ended}'`,
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

  test("a blocked fixture ends when the test that started it is killed", async () => {
    const { root, local, env } = setup();
    const release = join(root, "orphan-release");
    spawnSync("mkfifo", [release]);
    const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "remote-check-orphan.ts"), local, release], {
      env: { ...cleanEnv(), ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("started")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the child ended before the fixture started");
      seen += new TextDecoder().decode(chunk.value);
    }
    child.kill("SIGKILL");
    // The pipe closes only when the child and every shell of the check that
    // inherited it are gone; a fixture left waiting would keep it open.
    while (!(await reader.read()).done) {
      // drain
    }
    await child.exited;
  }, 30_000);

  test("a stop of the local check ends the command on the host", async () => {
    const { root, local, home, env } = setup();
    const started = join(root, "remote-started");
    const release = join(root, "remote-release");
    const pidFile = join(root, "remote.pid");
    spawnSync("mkfifo", [started, release]);
    const fakeHost = join(import.meta.dir, "fixtures", "remote-check-fake-host.ts");
    // The command ignores TERM, so only the remote side's last SIGKILL ends it.
    const command =
      `trap '' TERM; echo $$ > '${pidFile}'; echo started > '${started}'; ${holdUntilReleased(release)}`;
    const child = spawn("bash", [join(local, "scripts", "remote-check.sh"), command], {
      cwd: local,
      env: {
        ...cleanEnv(),
        ...env,
        OPERAD_CHECK_SSH: `bun ${fakeHost}`,
        FAKE_HOST_HOME: home,
      },
      detached: true,
      stdio: "ignore",
    });
    let pid = 0;
    try {
      await readFifo(started);
      pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      // The gate stops the local group: remote-check.sh, ssh and the check.
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      await waitForGone(pid, 5000);
    } finally {
      await Bun.spawn(["sh", "-c", `exec 3<>'${release}'; echo go >&3`], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // It already ended.
        }
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
    }
  }, 30_000);

  describe("slots and the integration lane", () => {
    /** Starts a check that reports its tree, then blocks until `release` is written. */
    function blocker(local: string, env: Record<string, string>, root: string, name: string) {
      const started = join(root, `${name}-started`);
      const release = join(root, `${name}-release`);
      spawnSync("mkfifo", [started, release]);
      const done = run(local, env, `pwd -P > '${started}'; ${holdUntilReleased(release)}; touch '${join(root, `${name}-ended`)}'`);
      return {
        done,
        started: async () => {
          const out = Bun.spawn(["cat", started], { stdin: "ignore", stdout: "pipe" });
          return (await new Response(out.stdout).text()).trim();
        },
        release: () =>
          Bun.spawn(["sh", "-c", `exec 3<>'${release}'; echo go >&3`], { stdin: "ignore" }).exited,
      };
    }

    test("with two slots two checks run at once in different trees and a third waits", async () => {
      const { root, local, home, env } = setup();
      const e = { ...env, OPERAD_CHECK_SLOTS: "2" };
      const a = blocker(local, e, root, "a");
      const b = blocker(local, e, root, "b");
      try {
        const [ta, tb] = await Promise.all([a.started(), b.started()]);
        expect(new Set([ta, tb]).size).toBe(2);
        expect([ta, tb].map((t) => realpathSync(t)).sort()).toEqual(
          [join(home, "Code", "operad"), join(home, "Code", "operad-slot2")].map((t) => realpathSync(t)).sort(),
        );
        const seen = join(root, "third-saw");
        // The third check records how many holders had ended when it ran.
        const third = run(local, e, `ls '${root}' | grep -c -- '-ended$' > '${seen}'; true`);
        await a.release();
        expect((await third).code).toBe(0);
        // It ran only after a holder ended, so it was waiting for a slot.
        expect(Number(readFileSync(seen, "utf8").trim())).toBeGreaterThanOrEqual(1);
        expect((await a.done).code).toBe(0);
      } finally {
        await a.release();
        await b.release();
        await Promise.all([a.done, b.done]);
      }
    });

    test("with every task slot taken an integration check runs at once, in its own tree", async () => {
      const { root, local, home, env } = setup();
      const e = { ...env, OPERAD_CHECK_SLOTS: "2" };
      const a = blocker(local, e, root, "a");
      const b = blocker(local, e, root, "b");
      try {
        const [ta, tb] = await Promise.all([a.started(), b.started()]);
        const result = await run(local, { ...e, OPERAD_CHECK_LANE: "integration" }, "pwd -P");
        expect(result.code).toBe(0);
        const tree = result.out.trim().split("\n").pop() ?? "";
        expect(realpathSync(tree)).toBe(realpathSync(join(home, "Code", "operad-integration")));
        expect([ta, tb]).not.toContain(realpathSync(tree));
      } finally {
        await a.release();
        await b.release();
        await Promise.all([a.done, b.done]);
      }
    });

    test("a task check never takes the integration slot, and a second integration waits for the first", async () => {
      const { root, local, env } = setup();
      const lane = { ...env, OPERAD_CHECK_SLOTS: "2", OPERAD_CHECK_LANE: "integration" };
      const first = blocker(local, lane, root, "i1");
      try {
        await first.started();
        const seen = join(root, "second-saw");
        const second = run(local, lane, `echo ran > '${seen}'`);
        // A task check is not held back by the integration check.
        const task = await run(local, { ...env, OPERAD_CHECK_SLOTS: "2" }, "true");
        expect(task.code).toBe(0);
        await first.release();
        expect((await second).code).toBe(0);
        expect(readFileSync(seen, "utf8").trim()).toBe("ran");
        expect((await first.done).code).toBe(0);
      } finally {
        await first.release();
        await first.done;
      }
    });

    test("a second integration check does not start while the first runs", async () => {
      const { root, local, env } = setup();
      const lane = { ...env, OPERAD_CHECK_LANE: "integration" };
      const started = join(root, "i1-started");
      const release = join(root, "i1-release");
      const ended = join(root, "i1-ended");
      const seen = join(root, "i2-saw");
      spawnSync("mkfifo", [started, release]);
      const first = run(local, lane, `echo s > '${started}'; ${holdUntilReleased(release)}; touch '${ended}'`);
      try {
        await readFifo(started);
        const second = run(local, lane, `if [ -f '${ended}' ]; then echo after > '${seen}'; else echo during > '${seen}'; fi`);
        await Bun.spawn(["sh", "-c", `echo go > '${release}'`], { stdin: "ignore" }).exited;
        expect((await first).code).toBe(0);
        expect((await second).code).toBe(0);
        expect(readFileSync(seen, "utf8").trim()).toBe("after");
      } finally {
        await Bun.spawn(["sh", "-c", `exec 3<>'${release}'; echo go >&3`], { stdin: "ignore" }).exited;
        await first;
      }
    });

    test("the command sees OPERAD_CHECK_SLOTS on the host", async () => {
      const { local, env } = setup();
      const result = await run(local, { ...env, OPERAD_CHECK_SLOTS: "3" }, 'echo "slots=$OPERAD_CHECK_SLOTS"');
      expect(result.out).toContain("slots=3");
    });

    for (const bad of ["0", "x", "-1", "1.5", "", "12x"]) {
      test(`OPERAD_CHECK_SLOTS='${bad}' stops with a message naming the variable`, async () => {
        const { local, env } = setup();
        const result = await run(local, { ...env, OPERAD_CHECK_SLOTS: bad }, "echo ran");
        expect(result.code).toBe(1);
        expect(result.err).toContain("OPERAD_CHECK_SLOTS");
        expect(result.out).not.toContain("ran");
      });
    }

    test("a bad OPERAD_CHECK_LANE stops with a message naming the variable", async () => {
      const { local, env } = setup();
      const result = await run(local, { ...env, OPERAD_CHECK_LANE: "fast" }, "echo ran");
      expect(result.code).toBe(1);
      expect(result.err).toContain("OPERAD_CHECK_LANE");
      expect(result.out).not.toContain("ran");
    });

    test("a bad OPERAD_CHECK_SLOTS or OPERAD_CHECK_LANE stops the check even with no host", async () => {
      const { local, env } = setup();
      for (const bad of [{ OPERAD_CHECK_SLOTS: "0" }, { OPERAD_CHECK_LANE: "fast" }]) {
        const result = await run(local, { ...env, OPERAD_CHECK_HOST: "", ...bad }, "echo ran");
        expect(result.code).toBe(1);
        expect(result.err).toContain(Object.keys(bad)[0] ?? "");
        expect(result.out).not.toContain("ran");
      }
    });

    test("an empty OPERAD_CHECK_LANE stops with a message naming the variable", async () => {
      const { local, env } = setup();
      for (const host of ["fake", ""]) {
        const result = await run(local, { ...env, OPERAD_CHECK_HOST: host, OPERAD_CHECK_LANE: "" }, "echo ran");
        expect(result.code).toBe(1);
        expect(result.err).toContain("OPERAD_CHECK_LANE");
        expect(result.out).not.toContain("ran");
      }
    });
  });
});

describe("remote-check.sh > the -- form", () => {
  test("a word with quotes, backquotes, $ and a regex arrives byte for byte and is not run", async () => {
    const { root, local, home, env } = setup();
    const nasty = `it's "q" \`touch ${root}/pwned1\` $(touch ${root}/pwned2) $HOME ${anchoredPattern("a > b (c) [d] 'e' \`f\`")}`;
    const got = join(root, "got");
    const result = await run(local, env, "bash", "-c", `printf %s "$1" > '${got}'; exit 5`, "x", nasty);
    expect(result.code).toBe(5);
    expect(readFileSync(got, "utf8")).toBe(nasty);
    expect(existsSync(join(root, "pwned1"))).toBe(false);
    expect(existsSync(join(root, "pwned2"))).toBe(false);
  });

  test("without a host the words run here as they are", async () => {
    const { root, local } = setup();
    const got = join(root, "got-local");
    const nasty = "a'b\"c`d`$e";
    const result = await run(local, { OPERAD_CHECK_HOST: "" }, "bash", "-c", `printf %s "$1" > '${got}'`, "x", nasty);
    expect(result.code).toBe(0);
    expect(readFileSync(got, "utf8")).toBe(nasty);
  });

  test("the committed dev.json rerun goes through remote-check.sh and finds the test", async () => {
    const { root, local, env } = setup();
    const name = "it `works` isn't broken";
    mkdirSync(join(local, "t"), { recursive: true });
    writeFileSync(join(local, "package.json"), "{}\n");
    writeFileSync(
      join(local, "t", "x.test.ts"),
      `import { test } from "bun:test";\ntest(${JSON.stringify(name)}, () => {});\n`,
    );
    git(local, "add", ".");
    git(local, "commit", "-q", "-m", "test file");
    const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", ".operad", "dev.json"), "utf8"));
    const templates: string[] = [
      config.gate.commands[0].failed.rerun,
      config.integration.keyCommands[0].failed.rerun,
    ];
    for (const template of templates) {
      const command = rerunCommand(template, name);
      const child = Bun.spawn(["bash", "-c", command], {
        cwd: local,
        env: { ...cleanEnv(), ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(`${out}${err}`).toContain("remote-check: checking");
      expect(`${out}${err}`).toContain("1 pass");
      expect(code).toBe(0);
    }
  });

  test("a rerun after a checkout that changes the workspace packages installs first and reaches the test", async () => {
    const { root, local, env } = setup();
    const name = "it runs after the install";
    const bin = join(root, "fakebin");
    mkdirSync(bin);
    const log = join(root, "order");
    // A fake bun: `install` links the workspace package; `test` needs the link.
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/bash\nif [ "$1" = install ]; then echo install >> '${log}'; mkdir -p node_modules/linked; exit 0; fi\n` +
        `[ -d node_modules/linked ] || { echo "stale install"; exit 1; }\necho "test $*" >> '${log}'; echo "1 pass"\n`,
    );
    chmodSync(join(bin, "bun"), 0o755);
    mkdirSync(join(local, "packages", "p"), { recursive: true });
    writeFileSync(join(local, "packages", "p", "package.json"), "{}\n");
    git(local, "add", ".");
    git(local, "commit", "-q", "-m", "new workspace package");
    const config = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", ".operad", "dev.json"), "utf8"));
    const command = rerunCommand(config.gate.commands[0].failed.rerun, name);
    const child = Bun.spawn(["bash", "-c", command], {
      cwd: local,
      env: { ...cleanEnv(), ...env, OPERAD_CHECK_PATH: bin },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(`${out}${err}`).not.toContain("stale install");
    expect(code).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toBe("install");
    expect(lines[1]).toStartWith("test ");
  });
});
