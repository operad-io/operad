import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openConfigLog, readConfig, storeRootOf } from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/trigger.ts", import.meta.url),
);
const devPluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/dev-emit.ts", import.meta.url),
);
const rulesPluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/rules.ts", import.meta.url),
);

function capture(): { io: CliIo; text(): string; errors(): string } {
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

async function makeHome(
  rules: unknown,
  plugins: readonly string[] = [pluginPath],
): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [...plugins],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  if (rules !== undefined) {
    writeFileSync(join(home, "triggers.json"), JSON.stringify(rules));
  }
  return home;
}

async function runIds(home: string): Promise<string[]> {
  const config = await readConfig(home);
  const log = openConfigLog(config);
  try {
    return (await log.runs()).map((run) => run.runId);
  } finally {
    await log.close();
  }
}

async function runFlows(home: string): Promise<string[]> {
  const config = await readConfig(home);
  const log = openConfigLog(config);
  try {
    return (await log.runs()).map((run) => run.flow);
  } finally {
    await log.close();
  }
}

async function runIdOfFlow(home: string, flow: string): Promise<string> {
  const config = await readConfig(home);
  const log = openConfigLog(config);
  try {
    const run = (await log.runs()).find((candidate) => candidate.flow === flow);
    if (run === undefined) throw new Error(`no run of flow ${flow}`);
    return run.runId;
  } finally {
    await log.close();
  }
}

describe("operad trigger rules", () => {
  test("a plugin's default rule alone starts its flow", async () => {
    const home = await makeHome(undefined, [rulesPluginPath]);
    const sent = capture();
    expect(
      await main(["trigger", "cron", "t1", "--type", "tick"], {
        home,
        io: sent.io,
      }),
    ).toBe(0);
    expect(sent.text()).toContain("started");
    expect(await runFlows(home)).toEqual(["plugin-one"]);
  });

  test("lists each rule with where it came from", async () => {
    const home = await makeHome(
      [
        {
          source: "cron",
          type: "tick",
          start: { flow: "plugin-two" },
          object: "job:2",
          mode: "candidate",
        },
      ],
      [rulesPluginPath],
    );
    const output = capture();
    expect(await main(["trigger", "rules"], { home, io: output.io })).toBe(0);

    expect(output.text()).toContain("cron tick -> plugin-two on job:2 (candidate)  from user");
    expect(output.text()).toContain(
      "manual go -> plugin-two on $event.object (auto)  from rules-fixture",
    );
    // The user's cron rule replaced the plugin's cron rule for that pair.
    expect(output.text()).not.toContain("plugin-one");
  });
});

describe("operad trigger", () => {
  test("sends an event, starts a run, and history names the event", async () => {
    const home = await makeHome([
      {
        source: "cron",
        type: "tick",
        start: { flow: "one", params: { from: "rule" } },
        object: "job:1",
        mode: "auto",
      },
    ]);
    const sent = capture();
    expect(
      await main(["trigger", "cron", "tick:1", "--type", "tick"], {
        home,
        io: sent.io,
      }),
    ).toBe(0);
    expect(sent.text()).toContain("started");

    const ids = await runIds(home);
    expect(ids).toHaveLength(1);
    const runId = ids[0];
    if (runId === undefined) throw new Error("no run");

    const executed = capture();
    expect(await main(["run-internal", runId], { home, io: executed.io })).toBe(
      0,
    );

    const history = capture();
    expect(await main(["history", runId], { home, io: history.io })).toBe(0);
    expect(history.text()).toContain('flow "one", started by cron tick');
    for (const word of ["fact", "effect", "node", "graph", "decide"]) {
      expect(history.text().toLowerCase()).not.toContain(word);
    }
  });

  test("candidates appear in pending and work through operad:start and dismiss", async () => {
    const home = await makeHome([
      {
        source: "cron",
        type: "tick",
        start: { flow: "one" },
        object: "job:1",
        mode: "candidate",
      },
    ]);
    const first = capture();
    expect(
      await main(["trigger", "cron", "c1", "--type", "tick"], {
        home,
        io: first.io,
      }),
    ).toBe(0);
    expect(first.text()).toContain("waiting");
    const pendingId = first.text().trim().split(/\s+/)[1];
    if (pendingId === undefined) throw new Error("no pending id");

    const pending = capture();
    expect(
      await main(["pending", "--json"], { home, io: pending.io }),
    ).toBe(0);
    const items = JSON.parse(pending.text()) as {
      pendingId: string;
      actions: { plugin: string; action: string }[];
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.pendingId).toBe(pendingId);
    expect(items[0]?.actions).toEqual([
      { plugin: "operad", action: "start" },
      { plugin: "operad", action: "dismiss" },
    ]);

    const started = capture();
    expect(
      await main(["operad:start", pendingId], { home, io: started.io }),
    ).toBe(0);
    expect(await runIds(home)).toHaveLength(1);

    const firstRun = (await runIds(home))[0];
    if (firstRun === undefined) throw new Error("no first run");
    expect(await main(["run-internal", firstRun], { home, io: capture().io })).toBe(
      0,
    );

    const second = capture();
    expect(
      await main(["trigger", "cron", "c2", "--type", "tick"], {
        home,
        io: second.io,
      }),
    ).toBe(0);
    const secondId = second.text().trim().split(/\s+/)[1];
    if (secondId === undefined) throw new Error("no second pending id");
    const dismissed = capture();
    expect(await main(["dismiss", secondId], { home, io: dismissed.io })).toBe(
      0,
    );
    expect(dismissed.text()).toContain("dismissed");
    expect(await runIds(home)).toHaveLength(1);
  });

  test("start and dismiss take --repo without counting it as an argument", async () => {
    const home = await makeHome([
      {
        source: "cron",
        type: "tick",
        start: { flow: "one" },
        object: "job:1",
        mode: "candidate",
      },
    ]);
    const ids: string[] = [];
    for (const name of ["c1", "c2"]) {
      const out = capture();
      expect(
        await main(["trigger", "cron", name, "--type", "tick"], { home, io: out.io }),
      ).toBe(0);
      const id = out.text().trim().split(/\s+/)[1];
      if (id === undefined) throw new Error("no pending id");
      ids.push(id);
    }
    const [toStart, toDismiss] = ids;
    if (toStart === undefined || toDismiss === undefined) throw new Error("no ids");

    const started = capture();
    expect(
      await main(["start", toStart, "--repo", "x"], { home, io: started.io }),
    ).toBe(0);
    expect(started.text()).toContain("started");
    expect(await runIds(home)).toHaveLength(1);

    const dismissed = capture();
    expect(
      await main(["dismiss", "--repo=x", toDismiss], { home, io: dismissed.io }),
    ).toBe(0);
    expect(dismissed.text()).toContain(`dismissed ${toDismiss}`);
  });

  test("a step running in a worker can emit an event", async () => {
    const home = await makeHome([
      {
        source: "manual",
        type: "go",
        start: { flow: "emitting" },
        object: "job:1",
        mode: "auto",
      },
      {
        source: "operad",
        type: "trigger.custom",
        start: { flow: "two" },
        object: "$event.object",
        mode: "auto",
      },
    ]);
    expect(
      await main(
        ["trigger", "manual", "go", "--type", "go", "--object", "job:1"],
        { home, io: capture().io },
      ),
    ).toBe(0);
    const first = (await runIds(home))[0];
    if (first === undefined) throw new Error("no run");
    expect(await main(["run-internal", first], { home, io: capture().io })).toBe(
      0,
    );
    const ids = await runIds(home);
    expect(ids).toHaveLength(2);

    const config = await readConfig(home);
    const log = openConfigLog(config);
    try {
      const runs = await log.runs();
      expect(runs.map((run) => run.flow)).toEqual(["emitting", "two"]);
    } finally {
      await log.close();
    }
  });

  test("the source operad is refused", async () => {
    const home = await makeHome([]);
    const output = capture();
    expect(
      await main(["trigger", "operad", "x", "--type", "run.done"], {
        home,
        io: output.io,
      }),
    ).toBe(2);
    expect(output.errors()).toContain("reserved");
  });

  test("invalid rules name the rule index and field", async () => {
    const home = await makeHome([
      {
        source: "cron",
        type: "tick",
        start: { flow: "one" },
        object: "job:1",
        mode: "sometimes",
      },
    ]);
    const output = capture();
    expect(
      await main(["trigger", "cron", "x", "--type", "tick"], {
        home,
        io: output.io,
      }),
    ).toBe(1);
    expect(output.errors()).toContain("rule 0: mode");
  });

  test("history of an observed event says what would have started", async () => {
    const home = await makeHome([
      {
        source: "cron",
        type: "tick",
        start: { flow: "one" },
        object: "job:1",
        mode: "observe",
      },
    ]);
    const sent = capture();
    expect(
      await main(["trigger", "cron", "observe:1", "--type", "tick"], {
        home,
        io: sent.io,
      }),
    ).toBe(0);
    expect(sent.text()).toContain("observed one on job:1");

    const config = await readConfig(home);
    const log = openConfigLog(config);
    let inputId: string | undefined;
    try {
      for await (const input of log.readInputs()) {
        if (input.source === "cron" && input.sourceKey === "observe:1") {
          inputId = input.inputId;
        }
      }
    } finally {
      await log.close();
    }
    if (inputId === undefined) throw new Error("the event was not recorded");

    const history = capture();
    expect(await main(["history", inputId], { home, io: history.io })).toBe(0);
    expect(history.text()).toContain("would start one on job:1");
  });

  test("a dev step may emit dev.ready but not another plugin's event", async () => {
    const home = await makeHome(
      [
        {
          source: "manual",
          type: "go",
          start: { flow: "dev-good" },
          object: "job:1",
          mode: "auto",
        },
        {
          source: "operad",
          type: "dev.ready",
          start: { flow: "two" },
          object: "$event.object",
          mode: "auto",
        },
        {
          source: "manual",
          type: "bad",
          start: { flow: "dev-bad" },
          object: "job:2",
          mode: "auto",
        },
        {
          source: "operad",
          type: "other.ready",
          start: { flow: "one" },
          object: "$event.object",
          mode: "auto",
        },
      ],
      [pluginPath, devPluginPath],
    );

    expect(
      await main(
        ["trigger", "manual", "go", "--type", "go", "--object", "job:1"],
        { home, io: capture().io },
      ),
    ).toBe(0);
    const good = await runIdOfFlow(home, "dev-good");
    expect(await main(["run-internal", good], { home, io: capture().io })).toBe(
      0,
    );
    expect((await runFlows(home)).sort()).toEqual(["dev-good", "two"]);

    expect(
      await main(
        ["trigger", "manual", "bad", "--type", "bad", "--object", "job:2"],
        { home, io: capture().io },
      ),
    ).toBe(0);
    const bad = await runIdOfFlow(home, "dev-bad");
    expect(await main(["run-internal", bad], { home, io: capture().io })).toBe(
      0,
    );
    const flows = await runFlows(home);
    expect(flows.sort()).toEqual(["dev-bad", "dev-good", "two"]);
    expect(flows).not.toContain("one");
  });
});
