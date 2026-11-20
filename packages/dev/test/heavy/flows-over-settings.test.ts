import { afterAll, describe, expect, test } from "bun:test";
import { createChatPlugin } from "@operad-io/chat";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginRegistry,
  SqlitePluginStore,
  createViews,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  startHttpServer,
  storeRootOf,
  SettingsError,
  listSettings,
  setSetting,
  type SettingsOptions,
} from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
import { addRepository, compileDevFlow, createDevPlugin } from "../../src/index.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  runInProcess,
  storeAt,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const CHAT = fileURLToPath(new URL("../../../chat/src/index.ts", import.meta.url));
const POOL = fileURLToPath(new URL("../../../pool/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../../shell/src/index.ts", import.meta.url));

type Step = { readonly id: string; readonly next?: Record<string, string> };

function flowFile(change: (steps: Step[]) => Step[] = (steps) => steps): string {
  const flow = compileDevFlow("mine", [{ stage: "work" }, { stage: "check" }, { stage: "human" }]);
  const steps = change(flow.steps.map((step) => ({ ...step }) as Step));
  return [
    `import { defineFlow } from ${JSON.stringify(ENGINE)};`,
    `export default defineFlow(${JSON.stringify({ ...flow, steps })} as never);`,
    "",
  ].join("\n");
}

const GOOD = { stages: [{ stage: "work" }, { stage: "check", commands: ["bun test"] }] };
const SAVED = { stages: [{ stage: "code" }, { stage: "test", commands: ["bun test"] }] };

async function setup(devJson: object = {}) {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify({
      plugins: [CHAT, PLUGIN, POOL, SHELL],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    })}\n`,
  );
  const path = await makeGitRepository(root);
  mkdirSync(join(path, ".operad", "flows"), { recursive: true });
  const devFile = join(path, ".operad", "dev.json");
  writeFileSync(devFile, `${JSON.stringify({ name: "repo", ...devJson }, null, 2)}\n`);
  writeFileSync(join(path, ".operad", "flows", "ts.flow.ts"), flowFile());
  writeFileSync(
    join(path, ".operad", "flows", "broken.flow.ts"),
    flowFile((steps) =>
      steps.map((step) =>
        step.id === "check" ? { ...step, next: { ...step.next, pass: "end_done" } } : step,
      ),
    ),
  );
  const store = storeAt(root);
  await addRepository(store, { path, name: "repo" });
  const registry = new PluginRegistry(
    [createChatPlugin(), createDevPlugin(), createPoolPlugin(), createShellPlugin()],
    { home: root, cwd: path, store, storeRoot: store.root },
  );
  const options: SettingsOptions = { registry, store, home: root };
  return { root, home, path, devFile, options };
}

interface Listed {
  readonly name: string;
  readonly source: string;
  readonly stages?: unknown[];
  readonly steps?: { id: string; use?: string }[];
  readonly refused?: string;
}

async function flowList(options: SettingsOptions): Promise<Listed[]> {
  const all = await listSettings(options, "repo");
  const found = all.find((item) => item.name === "dev.flowList");
  expect(found?.editable).toBe(false);
  return found?.value as unknown as Listed[];
}

async function refusal(promise: Promise<unknown>): Promise<SettingsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SettingsError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("dev.flows and dev.flowList in settings", () => {
  test("flowList reads dev.json, TypeScript and refused TypeScript flows", async () => {
    const { options } = await setup({ flows: { review: GOOD } });
    const list = await flowList(options);
    const byName = new Map(list.map((item) => [item.name, item]));
    expect(byName.get("default")?.source).toBe("built-in");
    expect(byName.get("default")?.stages).toHaveLength(4);
    expect(byName.get("review")?.source).toBe("dev.json");
    expect(byName.get("review")?.stages).toEqual(SAVED.stages);
    const ts = byName.get("ts");
    expect(ts?.source).toBe("typescript");
    expect(ts?.steps?.some((step) => step.use === "dev/integrate")).toBe(true);
    expect(ts?.refused).toBeUndefined();
    const broken = byName.get("broken");
    expect(broken?.source).toBe("typescript");
    expect(broken?.refused).toContain('.operad/flows/broken.flow.ts: ends without integrate');
    expect(broken?.steps).toBeUndefined();
    const flows = (await listSettings(options, "repo")).find((item) => item.name === "dev.flows");
    expect(flows?.editable).toBe(true);
    expect((await refusal(setSetting(options, "dev.flowList", [], { scope: "repo" }))).kind).toBe(
      "not-available",
    );
  });

  test("the built-in default lists the stages its worker, reviewer and gate give it", async () => {
    const { options } = await setup({
      worker: { use: "claude/agent", args: ["--model", "opus"] },
      reviewer: { use: "pi/agent", args: ["--model", "gpt"] },
      gate: { commands: ["bun test"] },
    });
    const built = (await flowList(options)).find((item) => item.name === "default");
    expect(built).toEqual({
      name: "default",
      source: "built-in",
      stages: [
        { stage: "code", use: "claude/agent", args: ["--model", "opus"] },
        { stage: "test", commands: ["bun test"] },
        { stage: "review", use: "pi/agent", args: ["--model", "gpt"] },
        { stage: "human" },
      ],
    });
  });

  test("a dev.json default is listed instead of the built-in one", async () => {
    const { options } = await setup({ flows: { default: GOOD } });
    const defaults = (await flowList(options)).filter((item) => item.name === "default");
    expect(defaults).toEqual([{ name: "default", source: "dev.json", stages: SAVED.stages }]);
  });

  test("a valid flow is saved whole or by name, and shows in the list", async () => {
    const { options, devFile } = await setup();
    await setSetting(options, "dev.flows", { one: GOOD }, { scope: "repo" });
    await setSetting(options, "dev.flows.two", GOOD, { scope: "repo" });
    const written = JSON.parse(readFileSync(devFile, "utf8"));
    expect(written.name).toBe("repo");
    expect(Object.keys(written.flows)).toEqual(["one", "two"]);
    expect(written.flows.one).toEqual(SAVED);
    expect(written.flows.two).toEqual(SAVED);
    expect((await flowList(options)).filter((item) => item.source === "dev.json")).toHaveLength(2);
    await setSetting(options, "dev.flows.two", null, { scope: "repo" });
    expect(Object.keys(JSON.parse(readFileSync(devFile, "utf8")).flows)).toEqual(["one"]);
  });

  test("a dev.json that cannot be read still lists flows and says why", async () => {
    const { options, devFile } = await setup();
    writeFileSync(devFile, `{ "name": "repo", "flows": `);
    const list = await flowList(options);
    const file = list.find((item) => item.name === "dev.json");
    expect(file?.refused).toContain("dev.json");
    expect(list.some((item) => item.name === "ts" && item.source === "typescript")).toBe(true);
    expect(list.some((item) => item.name === "default" && item.source === "built-in")).toBe(true);
  });

  test("an invalid flow already written does not block an unrelated setting", async () => {
    const { options, devFile } = await setup();
    writeFileSync(
      devFile,
      `${JSON.stringify(
        { name: "repo", concurrency: 1, flows: { bad: { stages: [{ stage: "work" }] } } },
        null,
        2,
      )}\n`,
    );
    await setSetting(options, "dev.concurrency", 3, { scope: "repo" });
    const written = JSON.parse(readFileSync(devFile, "utf8"));
    expect(written.concurrency).toBe(3);
    expect(written.flows.bad).toEqual({ stages: [{ stage: "work" }] });
    const refused = await refusal(
      setSetting(options, "dev.flows.good", GOOD, { scope: "repo" }),
    );
    expect(refused.kind).toBe("refused");
    expect(refused.message).toContain(
      "flows.bad.stages: needs at least one test, review or human stage",
    );
  });

  test("a save that breaks a rule is refused with dev's reason and writes nothing", async () => {
    const { options, devFile } = await setup();
    const before = readFileSync(devFile, "utf8");
    const noDecision = await refusal(
      setSetting(options, "dev.flows.bad", { stages: [{ stage: "work" }] }, { scope: "repo" }),
    );
    expect(noDecision.kind).toBe("refused");
    expect(noDecision.message).toBe(
      "flows.bad.stages: needs at least one test, review or human stage",
    );
    const whole = await refusal(
      setSetting(options, "dev.flows", { bad: { stages: [{ stage: "work" }] } }, { scope: "repo" }),
    );
    expect(whole.message).toBe(noDecision.message);
    const clash = await refusal(setSetting(options, "dev.flows.ts", GOOD, { scope: "repo" }));
    expect(clash.message).toBe(
      'flow "ts" is defined in dev.json and in .operad/flows/ts.flow.ts; keep one',
    );
    const unknown = await refusal(
      setSetting(options, "dev.flows.bad", { stages: [{ stage: "deploy" }] }, { scope: "repo" }),
    );
    expect(unknown.message).toContain("flows.bad.stages[0]");
    expect(readFileSync(devFile, "utf8")).toBe(before);
  });

  test("the command line lists and saves flows, and refuses with dev's reason", async () => {
    const { home, path, devFile } = await setup();
    const listed = await runInProcess(home, path, ["settings", "--repo", "repo", "--json"]);
    expect(listed.code).toBe(0);
    const names = (JSON.parse(listed.out) as { name: string }[]).map((item) => item.name);
    expect(names).toContain("dev.flows");
    expect(names).toContain("dev.flowList");
    const saved = await runInProcess(home, path, [
      "settings", "set", "dev.flows.mine", JSON.stringify(GOOD), "--repo", "repo",
    ]);
    expect(saved.code).toBe(0);
    expect(JSON.parse(readFileSync(devFile, "utf8")).flows.mine).toEqual(SAVED);
    const before = readFileSync(devFile, "utf8");
    const refused = await runInProcess(home, path, [
      "settings", "set", "dev.flows.bad", '{"stages":[{"stage":"work"}]}', "--repo", "repo",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("flows.bad.stages: needs at least one test, review or human stage");
    expect(readFileSync(devFile, "utf8")).toBe(before);
  });

  test("over HTTP a refusal is 422 with dev's reason, and the file is unchanged", async () => {
    const { root, home, devFile } = await setup();
    writeFileSync(
      join(home, "config.json"),
      `${JSON.stringify({
        plugins: [CHAT, PLUGIN, POOL, SHELL],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        http: { enabled: true, port: 0, listen: ["127.0.0.1"] },
      })}\n`,
    );
    const config = await readConfig(home);
    const store = new SqlitePluginStore({ root: storeRootOf(config) });
    const log = openConfigLog(config);
    const registry = await loadPluginRegistry({ home, store });
    const views = createViews({ registry, store, log, loadTimeoutMs: 200, onLog: () => undefined });
    const server = await startHttpServer({
      home,
      config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
      views,
      log,
      registry,
      onLog: () => undefined,
    });
    try {
      const token = await readHttpToken(home);
      const post = (value: unknown): Promise<Response> =>
        fetch(`${server.urls[0]}/v1/settings`, {
          method: "POST",
          headers: { authorization: `Bearer ${token?.token}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "dev.flows.bad", value, scope: "repo" }),
        });
      const before = readFileSync(devFile, "utf8");
      const refused = await post({ stages: [{ stage: "work" }] });
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        "flows.bad.stages: needs at least one test, review or human stage",
      );
      expect(readFileSync(devFile, "utf8")).toBe(before);
      const schemaRefused = await post({ stages: "not a list" });
      expect(schemaRefused.status).toBe(422);
      expect((await post(GOOD)).status).toBe(200);
      expect(JSON.parse(readFileSync(devFile, "utf8")).flows.bad).toEqual(SAVED);
    } finally {
      await server.stop();
      views.close();
      await log.close();
    }
  });
});
