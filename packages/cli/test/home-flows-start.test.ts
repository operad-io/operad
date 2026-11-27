import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Runner,
  cancelRun,
  readState,
  readStoredStart,
  recordAnswer,
  serveOnce,
  type LoadedFlow,
} from "@operad-io/engine";
import { makeHome } from "@operad-io/engine/testing";
import { operad as spawnedOperad } from "@operad-io/test-support";
import { main, openContext, type CliIo } from "../src/main.ts";
import { cleanupTempRoots } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const stepsPlugin = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/home-steps.ts", import.meta.url),
);
const ownFlowPlugin = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/own-flow.ts", import.meta.url),
);
const engine = fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url));

function flowText(steps: string): string {
  return `import { defineFlow } from ${JSON.stringify(engine)};
export default defineFlow({ name: "any", entry: "one", steps: [${steps}] });
`;
}

const END = `{ id: "end_done", kind: "end", params: { status: "done" }, replay: "safe" }`;
const call = (use: string): string =>
  `{ id: "one", kind: "plugin", params: { use: "${use}", params: {} }, replay: "safe", next: { ok: "end_done" } }`;

const FILES: Record<string, string> = {
  "echo.flow.ts": flowText(`${call("home-steps/echo")}, ${END}`),
  "stuck.flow.ts": flowText(`${call("home-steps/needs")}, ${END}`),
  "ask.flow.ts": flowText(
    `{ id: "one", kind: "wait_person", params: { prompt: "go?", choices: ["yes"] }, replay: "safe", next: { yes: "pause", interrupted: "end_done" } },
     { id: "pause", kind: "wait", params: { check: "home-steps/touch" }, replay: "safe", next: { ready: "end_done", interrupted: "end_done" } },
     ${END}`,
  ),
  "broken.flow.ts": "export default ;",
};

async function flowsHome(): Promise<string> {
  const { home } = await makeHome({ plugins: [stepsPlugin, ownFlowPlugin] });
  await mkdir(join(home, "flows"), { recursive: true });
  for (const [name, text] of Object.entries(FILES)) {
    await writeFile(join(home, "flows", name), text);
  }
  return home;
}

async function operad(home: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const io: CliIo = {
    write: (text) => {
      out += text;
    },
    error: (text) => {
      err += text;
    },
  };
  const code = await main(argv, { home, io });
  return { code, out, err };
}

async function withHome<T>(
  home: string,
  body: (context: Awaited<ReturnType<typeof openContext>>) => Promise<T>,
): Promise<T> {
  const context = await openContext(home, { write: () => undefined, error: () => undefined });
  try {
    return await body(context);
  } finally {
    context.views.close();
    await context.log.close();
  }
}

describe("the list of loaded flows", () => {
  test("flows --json gives a home flow and a plugin flow with their steps", async () => {
    const home = await flowsHome();
    const listed = await operad(home, "flows", "--json");
    const flows = JSON.parse(listed.out) as LoadedFlow[];
    const named = (name: string) => flows.find((flow) => flow.name === name);

    expect(named("home:echo")).toEqual({
      name: "home:echo",
      plugin: "home",
      source: null,
      startable: true,
      path: join(home, "flows", "echo.flow.ts"),
      entry: "one",
      steps: [
        { id: "one", kind: "plugin", use: "home-steps/echo", next: { ok: "end_done" } },
        { id: "end_done", kind: "end", status: "done" },
      ],
    });
    expect(named("home:ask")?.steps.slice(0, 2)).toEqual([
      { id: "one", kind: "wait_person", next: { yes: "pause", interrupted: "end_done" } },
      { id: "pause", kind: "wait", use: "home-steps/touch", next: { ready: "end_done", interrupted: "end_done" } },
    ]);
    expect(named("builtin-touch")).toMatchObject({
      plugin: "own-flow",
      startable: true,
      steps: [{ id: "one", kind: "plugin", use: "own-flow/touch", next: { ok: "end" } }],
    });
    expect(named("builtin-touch")?.path).toBeUndefined();
  });

  test("a flow that cannot start says why", async () => {
    const home = await flowsHome();
    const listed = await operad(home, "flows", "--json");
    const stuck = (JSON.parse(listed.out) as LoadedFlow[]).find((flow) => flow.name === "home:stuck");
    expect(stuck?.startable).toBe(false);
    expect(stuck?.problem).toBe('cannot start: needs "absent/step" from plugin absent, which is not loaded');

    const lines = await operad(home, "flows");
    expect(lines.out).toContain(`home:stuck  home  ${stuck?.problem}\n`);
  });
});

/** One pass of a serve that read the home as `context` did; the runs it gave a process. */
async function pass(
  context: Awaited<ReturnType<typeof openContext>>,
  home: string,
  logged: string[] = [],
): Promise<{ readonly runId: string; readonly held: boolean | undefined }[]> {
  const spawned: { runId: string; held: boolean | undefined }[] = [];
  await serveOnce({
    log: context.log,
    registry: context.registry,
    lockRoot: context.storeRoot,
    home,
    onLog: (message) => logged.push(message),
    spawnRun: (runId, options) => {
      spawned.push({ runId, held: options.held });
    },
  });
  return spawned;
}

async function startedRun(home: string, ...argv: string[]): Promise<string> {
  const started = await operad(home, "start", ...argv);
  expect(started.code).toBe(0);
  return /^started (\S+)\n$/.exec(started.out)?.[1] ?? "";
}

describe("a serve that read the home before a flow was there", () => {
  test("it applies an answer to the flow's run and can cancel it", async () => {
    const home = await flowsHome();
    await withHome(home, async (serving) => {
      await writeFile(join(home, "flows", "late.flow.ts"), FILES["ask.flow.ts"] ?? "");
      const answered = await startedRun(home, "home:late");
      expect((await operad(home, "run-internal", answered)).code).toBe(0);
      expect((await readState(serving.log, answered)).status).toBe("waiting_person");

      await recordAnswer({
        log: serving.log,
        runId: answered,
        choice: "yes",
        actor: { via: "cli", id: "tester" },
      });
      await pass(serving, home);
      expect((await readState(serving.log, answered)).status).not.toBe("waiting_person");

      await cancelRun({
        log: serving.log,
        flow: (name) => serving.registry.flow(name)?.flow,
        runId: answered,
        source: "operad",
      });
      await pass(serving, home);
      expect((await serving.log.run(answered))?.active).toBe(false);
    });
  });

  test("it gives no process to a run of the flow while a step it needs is missing", async () => {
    const home = await flowsHome();
    await withHome(home, async (serving) => {
      await writeFile(join(home, "flows", "late.flow.ts"), FILES["stuck.flow.ts"] ?? "");
      const runId = await withHome(home, async (context) =>
        (await context.log.startRun("home:late", "flow:home:late")).runId,
      );
      const logged: string[] = [];
      expect(await pass(serving, home, logged)).toEqual([]);
      expect(logged.join("\n")).toContain(`run ${runId}: cannot start: needs "absent/step"`);
    });
  });
});

describe("a run of a flow serve holds", () => {
  test("is not failed while the file on disk does not load", async () => {
    const home = await flowsHome();
    const runId = await startedRun(home, "home:echo");
    await withHome(home, async (serving) => {
      await writeFile(join(home, "flows", "echo.flow.ts"), "export default ;");
      expect(await pass(serving, home)).toEqual([{ runId, held: true }]);
    });

    // A process of its own, as serve starts it: this one already imported the file.
    const child = await spawnedOperad(home, ["run-internal", runId, "--held"]);
    expect(child.code).not.toBe(0);
    expect(child.err).toContain('flow "home:echo" is not loaded');
    expect((await operad(home, "running")).out).toContain(runId);

    await writeFile(join(home, "flows", "echo.flow.ts"), FILES["echo.flow.ts"] ?? "");
    expect((await spawnedOperad(home, ["run-internal", runId, "--held"])).code).toBe(0);
    expect((await operad(home, "history", runId)).out).toContain("run done");
  });
});

describe("starting a flow of the home by hand", () => {
  test("--params may come before the flow", async () => {
    const home = await flowsHome();
    for (const argv of [
      ["--params", '{"word":"hello"}', "home:echo"],
      ['--params={"word":"hello"}', "home:ask"],
    ]) {
      const runId = await startedRun(home, ...argv);
      await withHome(home, async (context) => {
        expect(readStoredStart(context.storeRoot, runId)).toMatchObject({
          params: { word: "hello" },
        });
      });
    }
  });

  test("the run's history says who started it", async () => {
    const home = await flowsHome();
    const runId = await startedRun(home, "home:echo");

    expect((await operad(home, "history", runId)).out).toMatch(/you started it: via cli, as \S+\n/);
    const entries = JSON.parse((await operad(home, "history", runId, "--json")).out) as unknown[];
    expect(entries).toContainEqual(
      expect.objectContaining({
        what: "you started it",
        actor: { via: "cli", id: expect.any(String) },
      }),
    );
    await withHome(home, async (context) => {
      const section = await context.views.section("flow:home:echo", "history");
      expect(section.markdown).toMatch(/you started it: via cli, as \S+/);
    });
  });

  test("a run of a flow whose file no longer loads fails, or is handed to its own process to fail", async () => {
    const home = await flowsHome();
    // The runs are made as a start made them while the file still loaded.
    for (const [flow, handed] of [["home:broken", true], ["home:gone", false]] as const) {
      const runId = await withHome(home, async (context) =>
        (await context.log.startRun(flow, `flow:${flow}`)).runId,
      );

      const spawned: string[] = [];
      await withHome(home, (context) =>
        serveOnce({
          log: context.log,
          registry: context.registry,
          lockRoot: context.storeRoot,
          home,
          spawnRun: (id) => {
            spawned.push(id);
          },
        }),
      );
      expect(spawned).toEqual(handed ? [runId] : []);
      if (handed) expect((await operad(home, "run-internal", runId)).code).toBe(0);

      expect((await operad(home, "running")).out).toBe("nothing is running\n");
      expect((await operad(home, "history", runId)).out).toContain(`flow "${flow}" is not loaded`);
    }
  });

  test("the run takes the params, reaches its end and records who started it", async () => {
    const home = await flowsHome();
    const started = await operad(home, "start", "home:echo", "--params", '{"word":"hello"}');
    expect(started.err).not.toContain("operad:");
    expect(started.code).toBe(0);
    const runId = /^started (\S+)\n$/.exec(started.out)?.[1] ?? "";
    expect(runId).not.toBe("");

    await withHome(home, async (context) => {
      await serveOnce({
        log: context.log,
        registry: context.registry,
        lockRoot: context.storeRoot,
        home,
        spawnRun: async (id) => {
          const run = await context.log.run(id);
          const found = run === undefined ? undefined : context.registry.flow(run.flow);
          const startInput = readStoredStart(context.storeRoot, id);
          if (found === undefined || startInput === undefined) throw new Error(`no start for ${id}`);
          await new Runner({
            log: context.log,
            flow: found.flow,
            runId: id,
            registry: context.registry,
            lockRoot: context.storeRoot,
            startInput,
          }).run();
        },
      });
      const run = await context.log.run(runId);
      expect(run).toMatchObject({ flow: "home:echo", object: "flow:home:echo", active: false });

      const said: string[] = [];
      for await (const fact of context.log.read(runId)) said.push(JSON.stringify(fact.payload));
      expect(said.join("\n")).toContain('"given":{"word":"hello"}');
      const actors: unknown[] = [];
      for await (const fact of context.log.readGlobal()) {
        if (fact.kind === "flow_started_by_hand") actors.push(fact.payload);
      }
      expect(actors).toEqual([
        { flow: "home:echo", runId, actor: { via: "cli", id: expect.any(String) } },
      ]);
    });

    const history = await operad(home, "history", runId);
    expect(history.out).toContain('flow "home:echo"');
  });

  test("a flow already running is not started twice", async () => {
    const home = await flowsHome();
    const first = await operad(home, "operad:start", "home:echo");
    const runId = /^started (\S+)\n$/.exec(first.out)?.[1] ?? "";

    const second = await operad(home, "start", "home:echo");
    expect(second.code).toBe(3);
    expect(second.out).toBe("");
    expect(second.err).toContain(`flow "home:echo" is already running (${runId})`);
    expect((await operad(home, "running")).out.trim().split("\n")).toHaveLength(1);
  });

  test("a refused start says why and starts nothing", async () => {
    const home = await flowsHome();
    const cases: readonly (readonly [readonly string[], number, string])[] = [
      [["home:nope"], 1, 'flow "home:nope" is not loaded'],
      [["home:broken"], 1, `flow "home:broken" is not loaded: flow file "${join(await realpath(home), "flows", "broken.flow.ts")}"`],
      [["home:stuck"], 2, 'cannot start: needs "absent/step"'],
      [["home:echo", "--params", "{word"], 2, "--params is not valid JSON"],
      [["home:echo", "--params", "[1]"], 2, "params must be a JSON object"],
      [["home:echo", "extra"], 2, "usage: operad start home:<name> [--params <json>]"],
    ];
    for (const [argv, code, reason] of cases) {
      const refused = await operad(home, "start", ...argv);
      expect(refused.err).toContain(reason);
      expect(refused.code).toBe(code);
      expect(refused.out).toBe("");
    }
    expect((await operad(home, "running")).out).toBe("nothing is running\n");
  });
});
