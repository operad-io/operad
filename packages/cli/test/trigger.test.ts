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

async function makeHome(rules: unknown): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
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
});
