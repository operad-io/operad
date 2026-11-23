import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPluginRegistry } from "@operad-io/engine";
import { fakeClock, makeHome, runFlow } from "@operad-io/engine/testing";
import { createShellPlugin } from "../../shell/src/index.ts";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const cronPluginPath = fileURLToPath(
  new URL("../../source-cron/src/index.ts", import.meta.url),
);
const flowPluginPath = fileURLToPath(
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

async function makeScheduledHome(): Promise<string> {
  return (await makeHome({ plugins: [flowPluginPath, cronPluginPath] })).home;
}

describe("operad routines", () => {
  test("adds a flow, lists it, and refuses an unknown flow", async () => {
    const home = await makeScheduledHome();
    const added = capture();
    expect(
      await main(
        [
          "routines",
          "add",
          "--flow",
          "plugin-one",
          "--schedule",
          "0 8 * * *",
          "--params",
          '{"from":"cli"}',
        ],
        { home, io: added.io },
      ),
    ).toBe(0);
    expect(added.text()).toContain("routine plugin-one");

    const listed = capture();
    expect(await main(["routines", "list", "--json"], { home, io: listed.io })).toBe(0);
    const entries = JSON.parse(listed.text()) as {
      flow: string;
      schedule: string;
      params: unknown;
      nextRun: string | null;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      flow: "plugin-one",
      schedule: "0 8 * * *",
      params: { from: "cli" },
    });
    expect(entries[0]?.nextRun).not.toBeNull();

    const refused = capture();
    expect(
      await main(
        ["routines", "add", "--flow", "missing", "--schedule", "0 8 * * *"],
        { home, io: refused.io },
      ),
    ).toBe(1);
    expect(refused.errors()).toContain('unknown flow "missing"');
  });

  test("an empty --params clears a flow's parameters", async () => {
    const home = await makeScheduledHome();
    await main(
      [
        "routines",
        "add",
        "--flow",
        "plugin-one",
        "--schedule",
        "0 8 * * *",
        "--params",
        '{"from":"cli"}',
      ],
      { home, io: capture().io },
    );
    const before = capture();
    expect(await main(["routines", "list", "--json"], { home, io: before.io })).toBe(0);
    const [entry] = JSON.parse(before.text()) as { readonly id: string }[];
    if (entry === undefined) throw new Error("no routine");
    expect(
      await main(["routines", "edit", entry.id, "--params", ""], {
        home,
        io: capture().io,
      }),
    ).toBe(0);
    const after = capture();
    expect(await main(["routines", "list", "--json"], { home, io: after.io })).toBe(0);
    const [cleared] = JSON.parse(after.text()) as { readonly params?: unknown }[];
    expect(cleared?.params).toBeUndefined();
  });

  test("the old name scheduled is gone, with no alias", async () => {
    const home = await makeScheduledHome();
    const short = capture();
    expect(await main(["scheduled", "list"], { home, io: short.io })).toBe(2);
    expect(short.errors()).toContain('unknown command "scheduled"');
    const viaPlugin = capture();
    expect(await main(["cron", "scheduled", "list"], { home, io: viaPlugin.io })).toBe(2);
    const empty = capture();
    expect(await main(["routines", "list"], { home, io: empty.io })).toBe(0);
    expect(empty.text()).toContain("no routines");
    const listed = capture();
    expect(await main(["cron", "routines", "list", "--json"], { home, io: listed.io })).toBe(0);
    expect(JSON.parse(listed.text())).toEqual([]);
  });
});

const shellPluginPath = fileURLToPath(
  new URL("../../shell/src/index.ts", import.meta.url),
);

describe("operad routines add --command", () => {
  test("refuses with shell off, names the command that turns it on, then adds with shell on", async () => {
    const off = (await makeHome({ plugins: [cronPluginPath] })).home;
    const refused = capture();
    expect(
      await main(["routines", "add", "--command", "echo hi", "--schedule", "0 3 * * *"], {
        home: off,
        io: refused.io,
      }),
    ).toBe(1);
    expect(refused.errors()).toContain("operad plugin enable shell");

    const on = (await makeHome({ plugins: [cronPluginPath, shellPluginPath] })).home;
    const added = capture();
    expect(
      await main(["routines", "add", "--command", "echo hi", "--schedule", "0 3 * * *"], {
        home: on,
        io: added.io,
      }),
    ).toBe(0);
    const listed = capture();
    expect(await main(["routines", "list"], { home: on, io: listed.io })).toBe(0);
    expect(listed.text()).toContain('command "echo hi"');
  });
});

describe("operad routines to-flow", () => {
  async function commandRoutine(cwd: string | undefined): Promise<{ home: string; storeRoot: string; id: string }> {
    const made = await makeHome({ plugins: [cronPluginPath, shellPluginPath] });
    const args = ["routines", "add", "--command", "echo from-flow; basename \"$PWD\"", "--schedule", "0 3 * * *"];
    if (cwd !== undefined) args.push("--cwd", cwd);
    expect(await main(args, { home: made.home, io: capture().io })).toBe(0);
    const listed = capture();
    await main(["routines", "list", "--json"], { home: made.home, io: listed.io });
    const [entry] = JSON.parse(listed.text()) as { id: string }[];
    if (entry === undefined) throw new Error("no routine");
    return { ...made, id: entry.id };
  }

  test("writes a flow file that loads and runs the command, and points the routine at it", async () => {
    const dir = (await makeHome({ prefix: "to-flow-cwd-" })).root;
    const { home, storeRoot, id } = await commandRoutine(dir);
    const out = capture();
    expect(await main(["routines", "to-flow", id, "--name", "nightly"], { home, io: out.io })).toBe(0);
    const file = join(home, "flows", "nightly.flow.ts");
    expect(out.text()).toContain("home:nightly");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("wait_person");
    expect(text).toContain("exit");

    const listed = capture();
    await main(["routines", "list", "--json"], { home, io: listed.io });
    const entries = JSON.parse(listed.text()) as { flow: string; command?: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.flow).toBe("home:nightly");

    // It loads against the steps of the loaded plugins, which validates it, and it runs.
    const registry = await loadPluginRegistry({ home, storeRoot, onLog: () => undefined });
    const flow = registry.flow("home:nightly")?.flow;
    if (flow === undefined) throw new Error("the flow file did not load");
    expect(registry.startProblem("home:nightly")).toBeUndefined();
    const shell = createShellPlugin({ clock: fakeClock(0) });
    const run = await runFlow({ ...shell, flows: [flow] }, flow, {
      inProcess: true,
      clock: fakeClock(0),
    });
    expect(run.end).toBe("done");
    const result = run.facts.find((fact) => fact.kind === "step_result");
    const data = ((result?.payload ?? {}) as { data?: { tail?: string[] } }).data;
    expect(data?.tail).toContain("from-flow");
    expect(data?.tail?.some((line) => line === basename(dir))).toBe(true);
  });

  test("refuses when the file already exists and changes nothing", async () => {
    const { home, id } = await commandRoutine(undefined);
    expect(await main(["routines", "to-flow", id, "--name", "mine"], { home, io: capture().io })).toBe(0);
    const again = capture();
    // A second command routine, converted to the same name, meets the file.
    expect(
      await main(["routines", "add", "--command", "date", "--schedule", "0 4 * * *"], { home, io: capture().io }),
    ).toBe(0);
    const after = capture();
    await main(["routines", "list", "--json"], { home, io: after.io });
    const second = (JSON.parse(after.text()) as { id: string; flow: string }[]).find((e) => e.flow === "shell:command");
    if (second === undefined) throw new Error("no second routine");
    const before = readFileSync(join(home, "flows", "mine.flow.ts"), "utf8");
    expect(await main(["routines", "to-flow", second.id, "--name", "mine"], { home, io: again.io })).toBe(1);
    expect(again.errors()).toContain("already exists");
    expect(readFileSync(join(home, "flows", "mine.flow.ts"), "utf8")).toBe(before);
    const last = capture();
    await main(["routines", "list", "--json"], { home, io: last.io });
    expect((JSON.parse(last.text()) as { flow: string }[]).filter((e) => e.flow === "shell:command")).toHaveLength(1);
  });

  test("the default name comes from the routine id; a routine that runs a flow is refused", async () => {
    const { home, id } = await commandRoutine(undefined);
    expect(await main(["routines", "to-flow", id], { home, io: capture().io })).toBe(0);
    expect(existsSync(join(home, "flows", `routine-${id}.flow.ts`))).toBe(true);

    const other = (await makeHome({ plugins: [flowPluginPath, cronPluginPath] })).home;
    await main(["routines", "add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], { home: other, io: capture().io });
    const listed = capture();
    await main(["routines", "list", "--json"], { home: other, io: listed.io });
    const [entry] = JSON.parse(listed.text()) as { id: string }[];
    const refused = capture();
    expect(await main(["routines", "to-flow", entry?.id ?? "", "--name", "x"], { home: other, io: refused.io })).toBe(1);
    expect(refused.errors()).toContain("does not run a command");
    expect(existsSync(join(other, "flows"))).toBe(false);
  });
});
