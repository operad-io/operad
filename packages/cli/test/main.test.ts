import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  Runner,
  answerRun,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  storeRootOf,
} from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/runner.ts", import.meta.url),
);

interface Output {
  readonly io: CliIo;
  text(): string;
  errors(): string;
}

function capture(): Output {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

async function makeHome(): Promise<{
  readonly root: string;
  readonly home: string;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
    }),
  );
  return { root, home };
}

/** Starts a flow and drives it as far as it goes without a person. */
async function startRun(home: string, flowName: string, object: string) {
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const log = openConfigLog(config);
  const store = new FilePluginStore({ root: join(storeRoot, "plugins") });
  const registry = await loadPluginRegistry({ home, store });
  const found = registry.flow(flowName);
  if (found === undefined) throw new Error(`missing flow ${flowName}`);
  const info = await log.startRun(flowName, object);
  await new Runner({
    log,
    flow: found.flow,
    runId: info.runId,
    registry,
    lockRoot: storeRoot,
  }).run();
  await log.close();
  return info.runId;
}

async function endRun(home: string, runId: string, choice: string): Promise<void> {
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({
    home,
    store: new FilePluginStore({ root: join(storeRoot, "plugins") }),
  });
  const found = registry.flow("ask");
  if (found === undefined) throw new Error("missing ask flow");
  await answerRun({ log, flow: found.flow, runId, choice });
  await log.close();
}

describe("operad command", () => {
  test("init creates the home and prints each plugin check", async () => {
    const { root, home } = await makeHome();
    const fresh = join(root, "fresh");
    const first = capture();
    expect(await main(["init"], { home: fresh, io: first.io })).toBe(0);
    expect(first.text()).toContain("created");
    expect(first.text()).toContain("no plugins loaded");
    const config = JSON.parse(
      readFileSync(join(fresh, "config.json"), "utf8"),
    ) as unknown;
    expect(config).toMatchObject({ store: { backend: "jsonl" } });

    const second = capture();
    expect(await main(["init"], { home, io: second.io })).toBe(0);
    expect(second.text()).toContain("test: ready");
  });

  test("flows lists the loaded flows and their plugin", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["flows"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("crash  test");
    expect(output.text()).toContain(pluginPath);
  });

  test("pending, running and history answer in user words", async () => {
    const { home } = await makeHome();
    const config = await readConfig(home);
    const storeRoot = storeRootOf(config);
    new FilePluginStore({ root: join(storeRoot, "plugins") }).put(
      "job",
      "1",
      { title: "Fix the gate" },
      "seed",
    );

    const waiting = await startRun(home, "ask", "job:1");
    const paused = await startRun(home, "pause", "job:2");

    const pendingOutput = capture();
    expect(
      await main(["pending", "--json"], { home, io: pendingOutput.io }),
    ).toBe(0);
    const pending = JSON.parse(pendingOutput.text()) as {
      runId: string;
      prompt: string;
      choices: string[];
      actions: { plugin: string; action: string }[];
    }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.runId).toBe(waiting);
    expect(pending[0]?.prompt).toBe("Approve this job?");
    expect(pending[0]?.actions).toEqual([{ plugin: "test", action: "approve" }]);

    const runningOutput = capture();
    expect(
      await main(["running", "--json"], { home, io: runningOutput.io }),
    ).toBe(0);
    const running = JSON.parse(runningOutput.text()) as {
      runId: string;
      step: string;
    }[];
    expect(running.map((item) => item.runId)).toEqual([paused]);
    expect(running[0]?.step).toBe("pause");

    const historyOutput = capture();
    expect(
      await main(["history", waiting, "--json"], {
        home,
        io: historyOutput.io,
      }),
    ).toBe(0);
    const entries = JSON.parse(historyOutput.text()) as {
      what: string;
      why: string;
    }[];
    expect(entries.some((entry) => entry.what === "waiting for you")).toBe(true);
    const text = historyOutput.text().toLowerCase();
    for (const word of ["fact", "effect", "node", "graph", "decide"]) {
      expect(text).not.toContain(word);
    }
  });

  test("history by object id shows every run of that object", async () => {
    const { home } = await makeHome();
    const first = await startRun(home, "ask", "job:7");
    await endRun(home, first, "stop");
    const second = await startRun(home, "ask", "job:7");
    const output = capture();
    expect(await main(["history", "job:7"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain(`run ${first} (ask)`);
    expect(output.text()).toContain(`run ${second} (ask)`);

    const json = capture();
    expect(
      await main(["history", "job:7", "--json"], { home, io: json.io }),
    ).toBe(0);
    const runs = JSON.parse(json.text()) as {
      id: string;
      flow: string;
      entries: { what: string }[];
    }[];
    expect(runs.map((run) => run.id)).toEqual([first, second]);
    expect(runs[0]?.entries.some((entry) => entry.what === "run done")).toBe(
      false,
    );
    expect(runs[1]?.entries.some((entry) => entry.what === "waiting for you")).toBe(
      true,
    );
  });

  test("exit codes: 1 unknown id, 2 usage, 4 lock held", async () => {
    const { home } = await makeHome();

    const unknown = capture();
    expect(
      await main(["history", "no-such-run"], { home, io: unknown.io }),
    ).toBe(1);
    expect(unknown.errors()).toContain("no run or object");

    const usage = capture();
    expect(await main(["nonsense"], { home, io: usage.io })).toBe(2);
    expect(usage.errors()).toContain("unknown command");

    const config = await readConfig(home);
    const log = openConfigLog(config);
    const ghost = await log.startRun("ghost", "job:1");
    await log.close();
    const state = capture();
    expect(
      await main(["run-internal", ghost.runId], { home, io: state.io }),
    ).toBe(3);
    expect(state.errors()).toContain("is not loaded");

    writeFileSync(
      join(home, "serve.lock"),
      `${JSON.stringify({ pid: process.ppid, at: Date.now() })}\n`,
    );
    const locked = capture();
    expect(await main(["serve"], { home, io: locked.io })).toBe(4);
    expect(locked.errors()).toContain("still alive");
  });

  test("history of 10 000 steps streams instead of buffering", async () => {
    const { home } = await makeHome();
    const config = await readConfig(home);
    const log = openConfigLog(config);
    const info = await log.startRun("big", "job:1");
    const facts = [
      {
        kind: "run_started",
        payload: { flow: "big" },
        cause: "test",
      },
    ];
    for (let index = 0; index < 10_000; index += 1) {
      facts.push({
        kind: "step_entered",
        payload: { step: `s${index}`, visit: 1, kind: "plugin" },
        cause: index + 1,
      });
    }
    await log.append(info.runId, 0, facts);
    await log.close();

    const output = capture();
    expect(
      await main(["history", info.runId], { home, io: output.io }),
    ).toBe(0);
    expect(output.text().split("\n").length).toBeGreaterThan(10_000);
  });
});
