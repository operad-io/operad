import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
} from "../../src/index.ts";
import {
  enterStep,
  markerEnv,
  parseEnvColumn,
  StepTracker,
  type ProcessRow,
  reapStale,
  runLine,
  type StepMarker,
} from "../../src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const started: ChildProcess[] = [];

afterEach(() => {
  // Only processes this test file started.
  for (const child of started.splice(0)) child.kill("SIGKILL");
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves when the pid is gone; the process is not our child once its parent ended. */
async function gone(pid: number): Promise<void> {
  while (alive(pid)) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A long-lived process we started with the given extra environment. */
function bystander(env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["-e", IDLE], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  started.push(child);
  return child;
}

// The idle process is the runtime itself: macOS withholds the environment of
// Apple's own binaries (sleep, sh, bash, zsh), so a test of the marker needs
// a process whose environment the system shows.
const IDLE = "setTimeout(() => {}, 300000)";
const DETACH = `"${process.execPath}" -e "const c=require('child_process').spawn(process.execPath,['-e','${IDLE}'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)"`;

function leaver(home: string) {
  return definePlugin({
    name: "leaver",
    kind: "domain",
    version: "0.0.1",
    steps: [
      {
        name: "run",
        results: ["ok"],
        run: async (ctx, params) => {
          const line =
            typeof params === "object" && params !== null && "line" in params
              ? String((params as { line: unknown }).line)
              : "true";
          const outcome = await runLine({
            line,
            cwd: ctx.cwd,
            signal: ctx.signal,
          });
          void home;
          return {
            result: "ok",
            data: { pid: Number(outcome.tail[0] ?? "0"), tail: [...outcome.tail] },
          };
        },
      },
    ],
  });
}

async function stepWith(line: string, runId: string, root: string, home: string) {
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const registry = new PluginRegistry([leaver(home)], { store, home });
  return registry.runStep("leaver/run", { line }, { runId, cwd: root });
}

/** Resolves when the file exists; a directory event says so. */
async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

function marker(runId: string, home: string): StepMarker {
  return { runId, step: "leaver/run", home };
}

describe("what a step leaves behind", () => {
  test("a detached loop in a new process group is gone when the step ends", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const outcome = await stepWith(DETACH, "run-1", root, home);
    const pid = Number(outcome.data?.pid);
    expect(pid).toBeGreaterThan(0);
    await gone(pid);
    const log = readFileSync(
      join(root, "store", "logs", "leaver", "runs", "run-1", "run.log"),
      "utf8",
    );
    expect(log).toContain("stopping 1 process it left running");
    expect(log).toContain(`${pid}: `);
  });

  test("a process of another run, and one with no marker, are not touched", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const other = bystander(markerEnv(marker("run-other", home)));
    const plain = bystander({});
    const outcome = await stepWith(DETACH, "run-2", root, home);
    await gone(Number(outcome.data?.pid));
    expect(other.exitCode).toBeNull();
    expect(plain.exitCode).toBeNull();
    expect(alive(other.pid ?? 0)).toBe(true);
    expect(alive(plain.pid ?? 0)).toBe(true);
  });

  test("a process of the same run and step in another home is not touched", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const elsewhere = bystander(markerEnv(marker("run-3", join(root, "other-home"))));
    const outcome = await stepWith(DETACH, "run-3", root, home);
    await gone(Number(outcome.data?.pid));
    expect(alive(elsewhere.pid ?? 0)).toBe(true);
  });

  test("a step that leaves nothing writes nothing to its log", async () => {
    const root = await tempRoot();
    const outcome = await stepWith("echo hi", "run-4", root, join(root, "home"));
    expect(outcome.result).toBe("ok");
    expect(
      await Bun.file(join(root, "store", "logs", "leaver", "runs", "run-4", "run.log")).exists(),
    ).toBe(false);
  });

  test("of two steps with one marker at once, only the last to end sweeps", () => {
    const one = marker("run-5", "/home");
    const first = enterStep(one);
    const second = enterStep(one);
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    expect(enterStep(one)()).toBe(true);
  });

  test("loops a command's shell left in the background are stopped, though the system hides their environment", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const pids = join(root, "pids");
    // What a coding agent's Bash tool does: its own process starts a shell in a
    // process group of its own; the shell starts loops in the background and
    // ends a few tens of milliseconds later, so the loops move to init. Nothing
    // waits for the step to look: the step watches the processes itself, as it runs.
    writeFileSync(
      join(root, "tool.sh"),
      `for k in 1 2 3; do ( while :; do :; done ) & echo $! >> "${pids}"; done\nsleep 0.05\n`,
    );
    writeFileSync(
      join(root, "agent.js"),
      `require("child_process").spawn("/bin/sh", [${JSON.stringify(join(root, "tool.sh"))}], { detached: true, stdio: "ignore" });\n`,
    );
    await stepWith(`"${process.execPath}" "${join(root, "agent.js")}"`, "run-6", root, home);
    const loops = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(loops).toHaveLength(3);
    for (const pid of loops) await gone(pid);
  });

  test("a process group id that was reused later is not taken for the step's", () => {
    let now = 100;
    const tracker = new StepTracker({ now: () => now });
    const row = (pid: number, ppid: number, pgid: number, startSec: number): ProcessRow => ({
      pid,
      ppid,
      pgid,
      startSec,
      command: `c${pid}`,
    });
    tracker.addRoot(10);
    // The step's process 10 starts a shell 500, which leads its own group.
    tracker.observe([row(10, 1, 10, 90), row(500, 10, 500, 95)]);
    // The shell ends; a loop it left keeps the group id.
    now = 120;
    const loop = row(501, 1, 500, 96);
    tracker.observe([loop]);
    expect(tracker.has(loop)).toBe(true);
    // The pid 500 is given to a stranger long after, and so is a member of its group.
    expect(tracker.has(row(500, 1, 500, 900))).toBe(false);
    expect(tracker.has(row(777, 1, 500, 900))).toBe(false);
    // A process of another group is not ours.
    expect(tracker.has(row(778, 1, 778, 97))).toBe(false);
  });

  test("a system shell that starts the marked process again is stopped with it", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const pidFile = join(root, "pid");
    const loop = spawn(
      "/bin/sh",
      ["-c", `echo $$ > "${pidFile}"; while :; do "$0" -e "${IDLE}"; done`, process.execPath],
      { env: { ...process.env, ...markerEnv(marker("run-dead", home)) }, stdio: "ignore" },
    );
    started.push(loop);
    await waitForFile(pidFile);
    const shell = loop.pid ?? 0;
    // The loop must have started its first child before the sweep looks.
    while (!Bun.spawnSync(["pgrep", "-P", String(shell)]).stdout.toString().trim()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await reapStale({ home, activeRunIds: [], log: () => undefined });
    await gone(shell);
    expect(Bun.spawnSync(["pgrep", "-P", String(shell)]).stdout.toString().trim()).toBe("");
  });

  test("the serve-start sweep stops a marked process whose run is not active", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stale = bystander(markerEnv(marker("run-dead", home)));
    const live = bystander(markerEnv(marker("run-live", home)));
    const foreign = bystander(markerEnv(marker("run-dead", join(root, "other-home"))));
    const messages: string[] = [];
    const found = await reapStale({
      home,
      activeRunIds: ["run-live"],
      log: (message) => messages.push(message),
    });
    expect(found.map((one) => one.pid)).toEqual([stale.pid ?? 0]);
    await gone(stale.pid ?? 0);
    expect(alive(live.pid ?? 0)).toBe(true);
    expect(alive(foreign.pid ?? 0)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("no longer active");
    expect(messages[0]).toContain(`${stale.pid}: `);
  });
});

describe("the ps -E command column", () => {
  test("an argument that spells the variables does not override the environment", () => {
    const column =
      "node run.js OPERAD_RUN=fake:arg OPERAD_RUN_HOME=fakehome HOME=/h OPERAD_RUN=real:step OPERAD_RUN_HOME=realhome PATH=/bin";
    expect(parseEnvColumn(column)).toEqual({ marker: "real:step", home: "realhome" });
  });

  test("a column without the variable carries no marker", () => {
    expect(parseEnvColumn("node run.js HOME=/h")).toBeUndefined();
  });
});
