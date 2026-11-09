import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { waitForFile } from "../../shell/test/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../shell/src/index.ts", import.meta.url));
const FLOW = fileURLToPath(new URL("./fixtures/check-flow.ts", import.meta.url));

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
    // The command records any TERM or INT it receives, then waits for the
    // release file and exits 0, leaving a mark that it ended by itself.
    const line =
      `sh -c 'trap "echo term > ${signalled}" TERM INT HUP; ` +
      `echo $$ >> ${started}; while [ ! -e ${release} ]; do sleep 0.05; done; ` +
      `echo $$ > ${join(work, "finished")}'`;
    const env = { CHECK_LINE: line };

    let serve = startServe(home, env);
    try {
      const runId = await trigger(home, env);
      expect(runId).not.toBe("");
      await waitForFile(started);

      const stopped = await operad(home, env, ["serve", "stop"]);
      expect({ code: stopped.code, out: stopped.out, err: stopped.err }).toEqual({
        code: 0,
        out: stopped.out,
        err: "",
      });
      await serve.exited;

      serve = startServe(home, env);
      // Let the new serve take its turns while the command still waits.
      await Bun.sleep(1_000);
      expect(existsSync(signalled)).toBe(false);
      expect(existsSync(join(work, "finished"))).toBe(false);

      writeFileSync(release, "go\n");
      await waitForFile(join(work, "finished"));
      expect(existsSync(signalled)).toBe(false);

      // The run ends done: the check passed with exit 0.
      const deadline = Date.now() + 20_000;
      let history = "";
      while (Date.now() < deadline) {
        history = (await operad(home, env, ["history", runId])).out;
        if (history.includes("run done")) break;
        await Bun.sleep(200);
      }
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
