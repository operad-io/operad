import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
} from "../../src/index.ts";
import {
  enterStep,
  markerEnv,
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
