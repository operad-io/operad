import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOLDER_HOLDS_DIRECTORY,
  holdFolder,
  releaseFolder,
  spawnPty,
  type Pty,
} from "../../src/platform/index.ts";

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
