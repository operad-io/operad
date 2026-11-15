import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createViews,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  SqlitePluginStore,
  startHttpServer,
  storeRootOf,
} from "@operad-io/engine";
import { addRepository, cancelPlan, removeRepository, setTaskPhase } from "../../src/service.ts";
import { bareId, planData, taskData } from "../../src/model.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  runInProcess,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const POOL = fileURLToPath(new URL("../../../pool/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../../../shell/src/index.ts", import.meta.url));

const HUMAN = { stages: [{ stage: "work" }, { stage: "human" }] };

async function setup() {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const path = await makeGitRepository(root);
  mkdirSync(join(path, ".operad"), { recursive: true });
  // Write `quick` first: the schema still lists `default` first.
  writeFileSync(
    join(path, ".operad", "dev.json"),
    `${JSON.stringify({ name: "repo", flows: { quick: HUMAN, default: HUMAN } }, null, 2)}\n`,
  );
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify({
      plugins: [PLUGIN, POOL, SHELL],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      http: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    })}\n`,
  );
  const config = await readConfig(home);
  const store = new SqlitePluginStore({ root: storeRootOf(config) });
  await addRepository(store, { path, name: "repo" });
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({ home, store });
  const views = createViews({
    registry,
    store,
    log,
    loadTimeoutMs: 200,
    onLog: () => undefined,
  });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  if (token === undefined) throw new Error("the server created no token");
  const base = server.urls[0];
  if (base === undefined) throw new Error("the server bound no address");
  return {
    root,
    home,
    path,
    store,
    registry,
    token: token.token,
    base,
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function act(
  fixture: Fixture,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${fixture.base}/v1/act`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json",
      "x-operad-client": "test",
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the answer is not an object");
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

async function object(
  fixture: Fixture,
  id: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/v1/objects/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  if (response.status !== 200) throw new Error(`GET ${id}: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

interface ActionView {
  readonly name: string;
  readonly args?: {
    readonly properties?: Record<
      string,
      { readonly enum?: readonly string[]; readonly items?: { readonly enum?: readonly string[] } }
    >;
  };
}

function actionOf(view: Record<string, unknown>, name: string): ActionView {
  const actions = view.actions;
  if (!Array.isArray(actions)) throw new Error("the object has no actions");
  const found = actions.find(
    (item): item is ActionView =>
      typeof item === "object" &&
      item !== null &&
      (item as { name?: unknown }).name === name,
  );
  if (found === undefined) throw new Error(`no action ${name}`);
  return found;
}

function errorOf(body: Record<string, unknown>): { kind: string; message: string } {
  const error = body.error;
  if (typeof error !== "object" || error === null) throw new Error("no error body");
  return error as { kind: string; message: string };
}

describe("dev:plan and dev:task", () => {
  test("over HTTP a plan and a task take their flow, request, brief and after", async () => {
    const fixture = await setup();
    try {
      const made = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: {
          title: "Ship the build",
          slug: "ship",
          request: "Make the build ship.",
          flow: "quick",
        },
      });
      expect(made.status).toBe(200);
      const planId = made.body.opens;
      expect(planId).toBe("plan:repo/P-0001-ship");
      expect(made.body.value).toBe("P-0001-ship");

      const plan = planData((await fixture.store.get("plan", "repo/P-0001-ship"))?.data ?? {});
      expect(plan).toMatchObject({
        repository: "repo",
        title: "Ship the build",
        request: "Make the build ship.",
        status: "draft",
        auto: "off",
        flow: "quick",
      });

      const first = await act(fixture, {
        action: "dev:task",
        id: "plan:repo/P-0001-ship",
        args: {
          title: "First step",
          slug: "first",
          brief: "Do the first step.",
          flow: "quick",
        },
      });
      expect(first.status).toBe(200);
      expect(first.body.opens).toBe("task:repo/T-0001-first");
      const firstId = "T-0001-first";
      const firstTask = taskData((await fixture.store.get("task", `repo/${firstId}`))?.data ?? {});
      expect(firstTask).toMatchObject({
        repository: "repo",
        plan: "P-0001-ship",
        title: "First step",
        flow: "quick",
        after: [],
        phase: "proposed",
      });
      expect(firstTask.brief).toContain("Do the first step.");
      expect(firstTask.brief).toContain("created");

      const second = await act(fixture, {
        action: "dev:task",
        id: "plan:repo/P-0001-ship",
        args: {
          title: "Second step",
          brief: "Do the second step.",
          flow: "default",
          after: [firstId],
        },
      });
      expect(second.status).toBe(200);
      expect(second.body.opens).toBe("task:repo/T-0002-second-step");
      const secondTask = taskData(
        (await fixture.store.get("task", "repo/T-0002-second-step"))?.data ?? {},
      );
      expect(secondTask.flow).toBe("default");
      expect(secondTask.after).toEqual(["repo/T-0001-first"]);
      expect(secondTask.brief).toContain("Do the second step.");
    } finally {
      await fixture.close();
    }
  });

  test("a slug left out comes from the title", async () => {
    const fixture = await setup();
    try {
      const plan = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "The release train!" },
      });
      expect(plan.status).toBe(200);
      expect(plan.body.opens).toBe("plan:repo/P-0001-the-release-train");

      const task = await act(fixture, {
        action: "dev:task",
        id: "plan:repo/P-0001-the-release-train",
        args: { title: "Tidy Up" },
      });
      expect(task.status).toBe(200);
      expect(task.body.opens).toBe("task:repo/T-0001-tidy-up");
    } finally {
      await fixture.close();
    }
  });

  test("the schemas list the repository's flows default first and the plan's tasks", async () => {
    const fixture = await setup();
    try {
      await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "Work", slug: "work" },
      });
      await act(fixture, {
        action: "dev:task",
        id: "plan:repo/P-0001-work",
        args: { title: "One", slug: "one" },
      });

      const repo = await object(fixture, "repo:repo");
      const planAction = actionOf(repo, "dev:plan");
      expect(planAction.args?.properties?.flow?.enum).toEqual(["default", "quick"]);

      const plan = await object(fixture, "plan:repo/P-0001-work");
      const taskAction = actionOf(plan, "dev:task");
      expect(taskAction.args?.properties?.flow?.enum).toEqual(["default", "quick"]);
      expect(taskAction.args?.properties?.after?.items?.enum).toEqual(["T-0001-one"]);
    } finally {
      await fixture.close();
    }
  });

  test("the task action offers only the plan's tasks that are not finished", async () => {
    const fixture = await setup();
    try {
      await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "Work", slug: "work" },
      });
      for (const [title, slug] of [
        ["Merged", "merged"],
        ["Cancelled", "cancelled"],
        ["Running", "running"],
      ] as const) {
        const made = await act(fixture, {
          action: "dev:task",
          id: "plan:repo/P-0001-work",
          args: { title, slug },
        });
        expect(made.status).toBe(200);
      }
      await setTaskPhase(fixture.store, "repo/T-0001-merged", "merged");
      await setTaskPhase(fixture.store, "repo/T-0002-cancelled", "cancelled");
      await setTaskPhase(fixture.store, "repo/T-0003-running", "running");

      const plan = await object(fixture, "plan:repo/P-0001-work");
      const taskAction = actionOf(plan, "dev:task");
      expect(taskAction.args?.properties?.after?.items?.enum).toEqual([
        "T-0003-running",
      ]);

      await setTaskPhase(fixture.store, "repo/T-0003-running", "merged");
      const finished = await object(fixture, "plan:repo/P-0001-work");
      const after = actionOf(finished, "dev:task").args?.properties?.after;
      expect(after).toBeDefined();
      expect(after?.items?.enum).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("operad task add --after still accepts a merged task", async () => {
    const fixture = await setup();
    try {
      await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "Work", slug: "work" },
      });
      const first = await act(fixture, {
        action: "dev:task",
        id: "plan:repo/P-0001-work",
        args: { title: "First", slug: "first" },
      });
      expect(first.status).toBe(200);
      await setTaskPhase(fixture.store, "repo/T-0001-first", "merged");

      const added = await runInProcess(
        fixture.home,
        fixture.path,
        [
          "task",
          "add",
          "--plan",
          "P-0001-work",
          "--slug",
          "second",
          "--title",
          "Second",
          "--after",
          "T-0001-first",
        ],
        "brief\n",
      );
      expect(added.code).toBe(0);
      expect(added.out.trim()).toBe("T-0002-second");
      const second = taskData(
        (await fixture.store.get("task", "repo/T-0002-second"))?.data ?? {},
      );
      expect(second.after).toEqual(["repo/T-0001-first"]);
    } finally {
      await fixture.close();
    }
  });

  test("the plan action asks before it creates", async () => {
    const fixture = await setup();
    try {
      const refused = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        args: { title: "No confirmation" },
      });
      expect(refused.status).toBe(409);
      expect(errorOf(refused.body).kind).toBe("confirm");
      expect((await fixture.store.list("plan")).objects).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a removed repository offers no plan action and creates no plan", async () => {
    const fixture = await setup();
    try {
      await removeRepository(fixture.store, "repo");

      const repo = await object(fixture, "repo:repo");
      const names = (repo.actions as readonly ActionView[]).map((action) => action.name);
      expect(names).not.toContain("dev:plan");

      const refused = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "After removal" },
      });
      expect(refused.status).toBe(409);
      expect(errorOf(refused.body).kind).toBe("not-available");
      expect((await fixture.store.list("plan")).objects).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("refusals are the command's: unknown flow, bad slug, cancelled plan", async () => {
    const fixture = await setup();
    try {
      const unknown = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "Unknown flow", flow: "missing" },
      });
      expect(unknown.status).toBe(400);
      expect(errorOf(unknown.body).kind).toBe("args");
      expect(errorOf(unknown.body).message).toContain('args.flow: "missing" is not one of');

      const bad = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "Bad slug", slug: "Bad Slug" },
      });
      expect(bad.status).toBe(422);
      expect(errorOf(bad.body).message).toBe(
        "slug: must use only a-z, 0-9 and -, with no leading or trailing -",
      );

      const plan = await act(fixture, {
        action: "dev:plan",
        id: "repo:repo",
        confirmed: true,
        args: { title: "Cancel me", slug: "cancel-me" },
      });
      expect(plan.status).toBe(200);
      const planKey = "repo/P-0001-cancel-me";
      await cancelPlan(fixture.store, planKey);

      const refused = await act(fixture, {
        action: "dev:task",
        id: `plan:${planKey}`,
        args: { title: "Too late", slug: "too-late" },
      });
      expect(refused.status).toBe(422);
      const actionMessage = errorOf(refused.body).message;
      expect(actionMessage).toBe('plan: plan "P-0001-cancel-me" is cancelled');

      let commandMessage = "";
      try {
        await fixture.registry.runCommand(
          ["dev", "task", "add", "--plan", bareId(planKey), "--slug", "too-late", "--title", "Too late"],
          { cwd: fixture.path, input: "brief\n" },
        );
      } catch (error) {
        commandMessage = error instanceof Error ? error.message : String(error);
      }
      expect(commandMessage).toBe(actionMessage);
    } finally {
      await fixture.close();
    }
  });
});
