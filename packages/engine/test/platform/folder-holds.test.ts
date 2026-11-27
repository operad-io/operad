import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLDER_HOLDS_DIRECTORY,
  holdFolder,
  readProcessTable,
  releaseFolder,
  spawnPty,
  type Pty,
} from "../../src/platform/index.ts";
import { leftJob } from "./left-job.ts";

const started: Pty[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const pty of started.splice(0)) {
    await pty.hangUp();
    await pty.exited;
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "operad-holds-")));
  directories.push(path);
  return path;
}

/** A shell that ends on a line of input and leaves a job running. */
function shellThatLeaves() {
  const job = leftJob(join(directory(), "left"));
  const pty = spawnPty({
    argv: ["bash", "--norc", "-c", `${job.line} read line`],
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
    onData: () => undefined,
  });
  started.push(pty);
  return { pty, job };
}

/**
 * An interactive shell whose job, in a process group of its own, ignores TERM
 * and HUP and holds a FIFO open: `up` settles once the job runs, `gone` once it
 * ended.
 */
function shellWithJob() {
  const fifo = join(directory(), "alive");
  execFileSync("mkfifo", [fifo]);
  const stream = createReadStream(fifo, { encoding: "utf8" });
  let ended = false;
  const up = new Promise<void>((resolve) => stream.once("data", () => resolve()));
  const gone = new Promise<void>((resolve) =>
    stream.once("end", () => {
      ended = true;
      resolve();
    }),
  );
  const job = `trap "" TERM HUP; exec 3>"$0"; echo up >&3; sleep 600`;
  const pty = spawnPty({
    argv: ["bash", "--norc", "-ic", `bash -c '${job}' '${fifo}'; true`],
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
    onData: () => undefined,
  });
  started.push(pty);
  return { pty, up, gone, ended: () => ended };
}

describe("a terminal that hangs up", () => {
  test("stops a job in another process group that ignores TERM and HUP", async () => {
    const shell = shellWithJob();
    await shell.up;
    await shell.pty.hangUp();
    await shell.gone;
    await shell.pty.exited;
  });
});

describe("after the shell exited", () => {
  test("a hang up stops the job it left in another process group", async () => {
    const { pty, job } = shellThatLeaves();
    await job.up;
    pty.write("\n");
    await pty.exited;
    expect(job.ended()).toBe(false);
    expect(await pty.alive()).toBe(true);
    await pty.hangUp();
    await job.gone;
    expect(await pty.alive()).toBe(false);
  });

  test("a release stops the job held by the terminal's marker", async () => {
    const home = directory();
    const folder = directory();
    const { pty, job } = shellThatLeaves();
    const hold = holdFolder({ home, folder, pid: pty.pid, marker: pty.marker });
    await job.up;
    pty.write("\n");
    await pty.exited;
    expect(await releaseFolder(home, folder)).toBe(1);
    await job.gone;
    expect(hold.released()).toBe(true);
    hold.drop();
  });

  test("a process that left the terminal to be a daemon is not stopped", async () => {
    const job = leftJob(join(directory(), "daemon"));
    const start = `require("child_process").spawn("sh",["-c",process.argv[1]],{detached:true,stdio:"ignore"}).unref()`;
    // `exec` makes the daemon itself the leader of the new session.
    const pty = spawnPty({
      argv: [process.execPath, "-e", start, `exec ${job.program}`],
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    started.push(pty);
    await pty.exited;
    await job.up;
    try {
      await pty.hangUp();
      expect(job.ended()).toBe(false);
      expect(await pty.alive()).toBe(false);
    } finally {
      process.kill(job.pid(), "SIGKILL");
    }
    await job.gone;
  });

  test("a hang up that cannot read the processes still stops the group, and is tried again", async () => {
    let fail = true;
    const pty = spawnPty({
      argv: ["sh", "-c", "read line"],
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      onData: () => undefined,
      table: async () => {
        if (fail) throw new Error("no process table");
        return await readProcessTable();
      },
    });
    started.push(pty);
    await expect(pty.hangUp()).rejects.toThrow("no process table");
    await pty.exited;
    fail = false;
    await pty.hangUp();
  });
});

describe("folder holds", () => {
  test("releasing a folder stops the trees held in it and below it, and tells their holders", async () => {
    const home = directory();
    const folder = directory();
    const below = join(folder, "app");
    mkdirSync(below);
    const beside = `${folder}-gate`;
    mkdirSync(beside);
    directories.push(beside);
    const inside = shellWithJob();
    const other = shellWithJob();
    const held = holdFolder({ home, folder: below, pid: inside.pty.pid });
    const kept = holdFolder({ home, folder: beside, pid: other.pty.pid });
    await Promise.all([inside.up, other.up]);
    expect(held.released()).toBe(false);

    expect(await releaseFolder(home, folder)).toBe(1);

    await inside.gone;
    expect(held.released()).toBe(true);
    expect(kept.released()).toBe(false);
    expect(other.ended()).toBe(false);
    // The holder can still ask after it took the hold off the list.
    held.drop();
    expect(held.released()).toBe(true);
    kept.drop();
    expect(readdirSync(join(home, FOLDER_HOLDS_DIRECTORY))).toEqual([]);
  });

  test("a hold whose process is not its holder's child is dropped, and nothing is signaled", async () => {
    const home = directory();
    const folder = directory();
    const shell = shellWithJob();
    await shell.up;
    holdFolder({ home, folder, pid: shell.pty.pid }).drop();
    // As a killed holder leaves it: the pid is now some other process's child.
    writeFileSync(
      join(home, FOLDER_HOLDS_DIRECTORY, "stale.json"),
      JSON.stringify({ pid: shell.pty.pid, owner: 1, folder, released: false }),
    );
    expect(await releaseFolder(home, folder)).toBe(0);
    expect(readdirSync(join(home, FOLDER_HOLDS_DIRECTORY))).toEqual([]);
    expect(shell.ended()).toBe(false);
  });

  test("a release never fails: no list, a broken entry or an unreadable table", async () => {
    const home = directory();
    const folder = directory();
    expect(await releaseFolder(home, folder)).toBe(0);
    const shell = shellWithJob();
    await shell.up;
    const hold = holdFolder({ home, folder, pid: shell.pty.pid });
    writeFileSync(join(home, FOLDER_HOLDS_DIRECTORY, "broken.json"), "{");
    const failing = async (): Promise<never> => {
      throw new Error("no process table");
    };
    expect(await releaseFolder(home, folder, { table: failing })).toBe(0);
    expect(await releaseFolder(home, folder)).toBe(1);
    await shell.gone;
    hold.drop();
  });
});
