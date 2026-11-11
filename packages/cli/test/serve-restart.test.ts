import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForChange } from "../../engine/src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { waitForFile, waitForPid } from "../../shell/test/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../shell/src/index.ts", import.meta.url));
const FLOW = fileURLToPath(new URL("./fixtures/check-flow.ts", import.meta.url));

/** The old one-second window at the 200 ms serve interval covered about five passes. */
const PASSES_BEFORE_RELEASE = 5;

/** Resolves once the serve has taken `count` turns, each one a line in `path`. */
async function waitForTicks(path: string, count: number): Promise<void> {
  for (;;) {
    let turns = 0;
    try {
      turns = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
    } catch {
      // Not there yet.
    }
    if (turns >= count) return;
    await waitForChange(dirname(path), basename(path), 100);
  }
}

interface Finished {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function operad(
  home: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<Finished> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: home,
    env: { ...(process.env as Record<string, string>), OPERAD_HOME: home, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

/**
 * `operad trigger` prints "started <run id>" and then stays alive on an open
 * handle, so the test reads that line and ends the command itself.
 */
async function trigger(home: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "trigger", "cron", "t1", "--type", "tick"],
    cwd: home,
    env: { ...(process.env as Record<string, string>), OPERAD_HOME: home, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  try {
    while (!/started \S+\n/.test(seen)) {
      const read = await reader.read();
      if (read.done) throw new Error(`trigger ended without starting a run: ${seen}`);
      seen += decoder.decode(read.value, { stream: true });
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
  return (/started (\S+)/.exec(seen)?.[1]) ?? "";
}

function startServe(home: string, env: Record<string, string>): Bun.Subprocess {
  const inherited = { ...(process.env as Record<string, string>) };
  // A run from inside a supervised serve must not make this serve supervised.
  delete inherited[SUPERVISED_ENV];
  return Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: {
      ...inherited,
      OPERAD_HOME: home,
      OPERAD_SERVE_INTERVAL_MS: "200",
      ...env,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

describe("a serve restart while a check runs", () => {
  test("a supervised serve keeps the supervisor's flag from its run process and the commands it runs", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [SHELL, FLOW],
        store: { backend: "jsonl", path: join(root, "store") },
        http: { enabled: false },
      }),
    );
    writeFileSync(
      join(home, "triggers.json"),
      JSON.stringify([
        { source: "cron", type: "tick", start: { flow: "check" }, object: "job:1", mode: "auto" },
      ]),
    );
    const seen = join(work, "seen");
    const expansion = "$" + "{" + SUPERVISED_ENV + "-unset}";
    const env = { CHECK_LINE: `sh -c 'echo "flag:${expansion}" > ${seen}.tmp && mv ${seen}.tmp ${seen}'` };
    const serve = startServe(home, { ...env, [SUPERVISED_ENV]: "1" });
    try {
      await trigger(home, env);
      await waitForFile(seen);
      // The command is a descendant of the run process: neither passed the flag on.
      expect(readFileSync(seen, "utf8").trim()).toBe("flag:unset");
    } finally {
      serve.kill("SIGTERM");
      await serve.exited;
    }
  }, 60_000);

  test("the check's command is not signalled and finishes with its exit code", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [SHELL, FLOW],
        store: { backend: "jsonl", path: join(root, "store") },
        http: { enabled: false },
      }),
    );
    writeFileSync(
      join(home, "triggers.json"),
      JSON.stringify([
        {
          source: "cron",
          type: "tick",
          start: { flow: "check" },
          object: "job:1",
          mode: "auto",
        },
      ]),
    );
    const started = join(work, "started");
    const release = join(work, "release");
    const signalled = join(work, "signalled");
    const ticks = join(work, "ticks");
    // The command records any TERM or INT it receives, then waits for the
    // release file and exits 0, leaving a mark that it ended by itself.
    const line =
      `sh -c 'trap "echo term > ${signalled}" TERM INT HUP; ` +
      `echo $$ >> ${started}; while [ ! -e ${release} ]; do sleep 0.05; done; ` +
      `echo $$ > ${join(work, "finished")}'`;
    const env = { CHECK_LINE: line, CHECK_TICKS: ticks };

    let serve = startServe(home, env);
    try {
      const runId = await trigger(home, env);
      expect(runId).not.toBe("");
      await waitForPid(started);

      const stopped = await operad(home, env, ["serve", "stop"]);
      expect({ code: stopped.code, out: stopped.out, err: stopped.err }).toEqual({
        code: 0,
        out: stopped.out,
        err: "",
      });
      await serve.exited;

      // Forget the first serve's marks, start the new serve and wait for five
      // passes, as the old one-second window did. A tick line is written at
      // the start of a pass, so wait for the sixth line: it proves the fifth
      // pass, including its active-run check, finished. Releasing on the fifth
      // line would race that check.
      rmSync(ticks, { force: true });
      serve = startServe(home, env);
      await waitForTicks(ticks, PASSES_BEFORE_RELEASE + 1);
      expect(existsSync(signalled)).toBe(false);
      expect(existsSync(join(work, "finished"))).toBe(false);

      writeFileSync(release, "go\n");
      await waitForPid(join(work, "finished"));
      expect(existsSync(signalled)).toBe(false);

      // The run ends done: the check passed with exit 0.
      await waitForFile(join(root, "store", "runs", `${runId}.end`));
      const history = (await operad(home, env, ["history", runId])).out;
      expect(history).toContain("run done");
      // The log path is not the run's words: a checkout path may contain "fail".
      expect(history.replace(/log at \S+/g, "")).not.toMatch(/fail|interrupt/i);
      // One start, and the process that started is the one that finished: the
      // run was neither stopped and started again nor run twice.
      const starts = readFileSync(started, "utf8").trim().split("\n");
      expect(starts).toHaveLength(1);
      expect(readFileSync(join(work, "finished"), "utf8").trim()).toBe(starts[0]);
    } finally {
      serve.kill("SIGTERM");
      await serve.exited;
    }
  }, 60_000);
});
