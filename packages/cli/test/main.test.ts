import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqlitePluginStore,
  Runner,
  answerRun,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  serveOnce,
  storeRootOf,
} from "@operad-io/engine";
import { addRepository } from "../../dev/src/service.ts";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { fakeRadian } from "../../harness/radian/test/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/runner.ts", import.meta.url),
);

const examplePluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/example-plugin/index.ts", import.meta.url),
);

const notesPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/notes.ts", import.meta.url),
);

const poolPluginPath = fileURLToPath(
  new URL("../../pool/src/index.ts", import.meta.url),
);
const shellPluginPath = fileURLToPath(
  new URL("../../shell/src/index.ts", import.meta.url),
);
const devPluginPath = fileURLToPath(
  new URL("../../dev/src/index.ts", import.meta.url),
);

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

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
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return { root, home };
}

/** Starts a flow and drives it as far as it goes without a person. */
async function startRun(home: string, flowName: string, object: string) {
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const log = openConfigLog(config);
  const store = new SqlitePluginStore({ root: storeRoot });
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
    store: new SqlitePluginStore({ root: storeRoot }),
  });
  const found = registry.flow("ask");
  if (found === undefined) throw new Error("missing ask flow");
  await answerRun({ log, flow: found.flow, runId, choice, actor: { via: "test", id: "tester" } });
  await log.close();
}

async function makeNamedHome(plugins: Record<string, unknown>): Promise<{
  readonly root: string;
  readonly home: string;
}> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      plugins,
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return { root, home };
}

describe("operad command", () => {
  test("init creates the home and prints each plugin check", async () => {
    const { root, home } = await makeHome();
    const fresh = join(root, "fresh");
    const bin = await fakeRadian(root);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      const first = capture();
      expect(await main(["init"], { home: fresh, io: first.io })).toBe(0);
      expect(first.text()).toContain("created");
      expect(first.text()).toContain("shell: ready");
      expect(first.text()).toContain("radian: radian is available");
      expect(first.text()).toContain("dev: no repositories registered");
      expect(
        JSON.parse(readFileSync(join(fresh, "config.json"), "utf8")),
      ).toMatchObject({
        plugins: {
          shell: { module: "@operad-io/shell", enabled: true },
          "radian": {
            module: "@operad-io/harness-radian",
            enabled: true,
          },
          dev: { module: "@operad-io/dev", enabled: true },
        },
      });
      const config = JSON.parse(
        readFileSync(join(fresh, "config.json"), "utf8"),
      ) as unknown;
      expect(config).toMatchObject({ store: { backend: "sqlite" } });

      const second = capture();
      expect(await main(["init"], { home, io: second.io })).toBe(0);
      expect(second.text()).toContain("test: ready");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("init reports an unreachable registered remote as a failed check", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const storeRoot = join(root, "store");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { dev: { module: devPluginPath } },
        store: { backend: "sqlite", path: join(storeRoot, "log.sqlite") },
      }),
    );

    const remote = join(root, "origin.git");
    runGit(root, ["init", "--bare", "-q", remote]);
    const repository = join(root, "repository");
    runGit(root, ["init", "-q", "-b", "main", repository]);
    writeFileSync(join(repository, "README.md"), "# test\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "start",
    ]);
    runGit(repository, ["remote", "add", "origin", remote]);
    runGit(repository, ["push", "-q", "-u", "origin", "main"]);

    const store = new SqlitePluginStore({ root: storeRoot });
    await addRepository(store, { path: repository });
    runGit(repository, [
      "remote",
      "set-url",
      "origin",
      join(root, "missing.git"),
    ]);

    const output = capture();
    expect(await main(["init"], { home, io: output.io })).toBe(1);
    expect(output.text()).toContain('dev: repository "repository"');
    expect(output.text()).toContain('cannot reach remote "origin"');
  });

  test("init reports a missing radian and leaves a complete config", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const previous = process.env.PATH;
    process.env.PATH = empty;
    try {
      const output = capture();
      expect(await main(["init"], { home, io: output.io })).toBe(1);
      expect(output.text()).toContain(
        "radian: radian was not found on PATH",
      );
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }

    // The home and its config are complete; the failed check wrote nothing else.
    const config = JSON.parse(
      readFileSync(join(home, "config.json"), "utf8"),
    ) as {
      plugins: Record<string, { enabled: boolean }>;
      store: { backend: string };
    };
    expect(config.plugins["radian"]?.enabled).toBe(true);
    expect(config.store.backend).toBe("sqlite");

    const list = capture();
    expect(await main(["repo", "list"], { home, io: list.io })).toBe(0);
    expect(list.text()).toContain("no repositories");
  });

  test("repo add refuses a directory with no remote and writes nothing", async () => {
    const { root, home } = await makeNamedHome({
      dev: { module: devPluginPath },
    });
    const noRemote = join(root, "no-remote");
    runGit(root, ["init", "-q", "-b", "main", noRemote]);

    const output = capture();
    expect(await main(["repo", "add", noRemote], { home, io: output.io })).toBe(
      1,
    );
    expect(output.errors()).toContain("has no remote");
    expect(existsSync(join(noRemote, ".operad", "dev.json"))).toBe(false);

    const list = capture();
    expect(await main(["repo", "list"], { home, io: list.io })).toBe(0);
    expect(list.text()).toContain("no repositories");
  });

  test("flows lists the loaded flows and their plugin", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["flows"], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("crash  test");
    expect(output.text()).toContain(pluginPath);
  });

  test("flows shows a flow that cannot start, and why, on its line", async () => {
    const { home } = await makeNamedHome({
      dev: { module: devPluginPath },
      pool: { module: poolPluginPath, enabled: false },
      shell: { module: shellPluginPath },
    });
    const output = capture();
    expect(await main(["flows"], { home, io: output.io })).toBe(0);
    const line = output.text().split("\n").find((item) => item.startsWith("dev  "));
    expect(line).toContain(
      'cannot start: needs "pool/agent" from plugin pool, which is disabled (operad plugin enable pool)',
    );

    const json = capture();
    expect(await main(["flows", "--json"], { home, io: json.io })).toBe(0);
    expect(json.text()).toContain('"startable": false');

    const enabled = capture();
    expect(await main(["plugin", "enable", "pool"], { home, io: enabled.io })).toBe(0);
    const again = capture();
    expect(await main(["flows"], { home, io: again.io })).toBe(0);
    expect(again.text()).not.toContain("cannot start");
  });

  test("pending, running and history answer in user words", async () => {
    const { home } = await makeHome();
    const config = await readConfig(home);
    const storeRoot = storeRootOf(config);
    new SqlitePluginStore({ root: storeRoot }).put(
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

  test("an action records its actor and history shows it", async () => {
    const { home } = await makeHome();
    const config = await readConfig(home);
    const storeRoot = storeRootOf(config);
    new SqlitePluginStore({ root: storeRoot }).put(
      "job",
      "1",
      { title: "Fix the gate" },
      "seed",
    );
    const runId = await startRun(home, "ask", "job:1");

    const output = capture();
    expect(
      await main(["test:approve", "job:1"], { home, io: output.io }),
    ).toBe(0);
    // The CLI records the answer and returns; only serve applies it.
    expect(output.text()).toContain("recorded; it runs when `operad serve` is running");

    const log = openConfigLog(config);
    const applyRegistry = await loadPluginRegistry({
      home,
      store: new SqlitePluginStore({ root: storeRoot }),
    });
    await serveOnce({
      log,
      registry: applyRegistry,
      lockRoot: storeRoot,
      spawnRun: () => undefined,
    });
    await log.close();

    const store = new SqlitePluginStore({ root: storeRoot });
    const actionFact = store
      .facts()
      .find((fact) => fact.type === "action_invoked");
    expect(actionFact?.data.actor).toMatchObject({ via: "cli" });
    expect(
      (actionFact?.data.actor as { readonly id?: string } | undefined)?.id,
    ).toBeTruthy();

    const history = capture();
    expect(
      await main(["history", runId, "--json"], { home, io: history.io }),
    ).toBe(0);
    const entries = JSON.parse(history.text()) as {
      what: string;
      actor?: { via: string; id: string };
    }[];
    const answered = entries.find((entry) =>
      entry.what.startsWith("you chose"),
    );
    expect(answered?.actor).toMatchObject({ via: "cli" });
    expect(answered?.actor?.id).toBeTruthy();
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
    // HTTP is on by default; a second serve must not open the port first.
    expect(locked.text()).not.toContain("http http://");
  });

  test("history resolves a plugin object without mixing object types", async () => {
    const { home } = await makeHome();
    await startRun(home, "ask", "task:42");
    await startRun(home, "pause", "brief:42");

    const ambiguous = capture();
    expect(await main(["history", "42"], { home, io: ambiguous.io })).toBe(1);
    expect(ambiguous.errors()).toContain("ambiguous");

    const taskOutput = capture();
    expect(
      await main(["history", "task:42"], { home, io: taskOutput.io }),
    ).toBe(0);
    expect(taskOutput.text()).toContain("waiting for you");
    expect(taskOutput.text()).not.toContain("waiting for pause");

    const briefOutput = capture();
    expect(
      await main(["history", "brief:42"], { home, io: briefOutput.io }),
    ).toBe(0);
    expect(briefOutput.text()).toContain("waiting for pause");
    expect(briefOutput.text()).not.toContain("waiting for you");
  });

  test("history does not resolve an object type no plugin declares", async () => {
    const { home } = await makeHome();
    await startRun(home, "ask", "bogus:42");
    const output = capture();
    expect(await main(["history", "bogus:42"], { home, io: output.io })).toBe(1);
    expect(output.text()).not.toContain("waiting");
  });

  test("serve rejects arguments as a usage error", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["serve", "unexpected"], { home, io: output.io })).toBe(2);
    expect(output.errors()).toContain("serve takes no arguments");
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

  test("plugin list, enable and disable follow the config", async () => {
    const { home } = await makeNamedHome({
      notes: { module: notesPath, enabled: false },
    });

    const listed = capture();
    expect(await main(["plugin", "list"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("notes  -  disabled");

    const command = capture();
    expect(await main(["notes", "add", "hello"], { home, io: command.io })).toBe(3);
    expect(command.errors()).toContain('plugin "notes" is disabled');

    const enabled = capture();
    expect(await main(["plugin", "enable", "notes"], { home, io: enabled.io })).toBe(0);
    expect(enabled.text()).toContain("notes: enabled");

    const added = capture();
    expect(await main(["notes", "add", "hello"], { home, io: added.io })).toBe(0);
    expect(added.text()).toContain("hello");

    const disabled = capture();
    expect(await main(["plugin", "disable", "notes"], { home, io: disabled.io })).toBe(0);
    expect(disabled.text()).toContain("notes: disabled");
  });

  test("plugin enable adds a shipped plugin the default config leaves out", async () => {
    const { home } = await makeNamedHome({});
    const enabled = capture();
    expect(await main(["plugin", "enable", "pi"], { home, io: enabled.io })).toBe(0);
    expect(enabled.text()).toContain("pi: enabled");

    const listed = capture();
    expect(await main(["plugin", "list"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("pi  0.0.0  enabled");

    const claude = capture();
    expect(await main(["plugin", "enable", "claude"], { home, io: claude.io })).toBe(0);
    expect(claude.text()).toContain("claude: enabled");

    const pool = capture();
    expect(await main(["plugin", "enable", "pool"], { home, io: pool.io })).toBe(0);
    expect(pool.text()).toContain("pool: enabled");

    const unknown = capture();
    expect(await main(["plugin", "enable", "no-such"], { home, io: unknown.io })).not.toBe(0);
    expect(unknown.errors()).toContain("no such plugin");
  });

  test("plugin list does not import a disabled plugin", async () => {
    const { root, home } = await makeNamedHome({});
    const marker = join(root, "loaded.marker");
    const modulePath = join(root, "side-effect.ts");
    await Bun.write(
      modulePath,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
        `export default { name: "lazy", kind: "domain", version: "0.0.1" };\n`,
    );
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { lazy: { module: modulePath, enabled: false } },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );

    const listed = capture();
    expect(await main(["plugin", "list"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("lazy  -  disabled");
    expect(existsSync(marker)).toBe(false);
  });

  test("plugin check validates a declaration without starting a run", async () => {
    const { home } = await makeNamedHome({});
    const output = capture();
    expect(await main(["plugin", "check", notesPath], { home, io: output.io })).toBe(0);
    expect(output.text()).toContain("notes: ok");
  });

  test("plugin check passes for the plugin in docs/plugin-authoring.md", async () => {
    const { home } = await makeNamedHome({});
    const output = capture();
    expect(
      await main(["plugin", "check", examplePluginPath], { home, io: output.io }),
    ).toBe(0);
    expect(output.text()).toContain("notes: ok");
  });

  test("secret set, list and delete never print the value", async () => {
    const { home } = await makeNamedHome({});
    const set = capture();
    const setIo: CliIo = {
      ...set.io,
      readLine: async () => "s3cr3t-value",
    };
    expect(await main(["secret", "set", "notes", "token"], { home, io: setIo })).toBe(0);
    expect(set.text()).toContain('secret "token" set');
    expect(set.text()).not.toContain("s3cr3t-value");

    const list = capture();
    expect(await main(["secret", "list", "notes"], { home, io: list.io })).toBe(0);
    expect(list.text()).toBe("token\n");
    expect(list.text()).not.toContain("s3cr3t-value");

    const remove = capture();
    expect(await main(["secret", "delete", "notes", "token"], { home, io: remove.io })).toBe(0);

    const empty = capture();
    expect(await main(["secret", "list", "notes"], { home, io: empty.io })).toBe(0);
    expect(empty.text()).toContain("no secrets");
  });

  test("plugin disable is refused while a run uses one of its steps", async () => {
    const { home } = await makeNamedHome({ test: { module: pluginPath } });
    const config = await readConfig(home);
    const log = openConfigLog(config);
    const info = await log.startRun("crash", "job:1");
    await log.close();

    const output = capture();
    expect(await main(["plugin", "disable", "test"], { home, io: output.io })).toBe(3);
    expect(output.errors()).toContain(info.runId);
  });
});
