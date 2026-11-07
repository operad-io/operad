import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  definePlugin,
  PluginRegistry,
  Runner,
  answerRun,
  historyEntries,
  loadPluginRegistry,
  openLog,
  openPluginStore,
  readState,
  type AskTimer,
  type Fact,
  type LogBackend,
} from "../../src/index.ts";
import { useGrant } from "../../src/runner/grants.ts";
import plugin from "../fixtures/plugins/resume.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(new URL("../fixtures/plugins/resume.ts", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/ask-child.ts", import.meta.url));
const ACTOR = { via: "cli", id: "me" } as const;

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

/** A grace timer the test fires by hand. */
class FakeTimer {
  private fires: (() => void)[] = [];
  private waiters: (() => void)[] = [];
  readonly timer: AskTimer = (_ms, fire) => {
    this.fires.push(fire);
    for (const waiter of this.waiters.splice(0)) waiter();
    return () => undefined;
  };
  armed(): Promise<void> {
    if (this.fires.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  fire(): void {
    this.fires.at(-1)?.();
  }
}

async function setup(mode: "memory" | "file") {
  const root = await tempRoot();
  const home = join(root, "home");
  const dir = join(root, "flags");
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const storeRoot = join(root, "store");
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({ plugins: [pluginPath], store: { backend: "jsonl", path: storeRoot } }),
  );
  const log = openLog({ backend: "jsonl", path: storeRoot });
  const registry =
    mode === "memory"
      ? new PluginRegistry([plugin], {
          home,
          storeRoot,
          store: new MemoryPluginStore({ root: storeRoot }),
        })
      : await loadPluginRegistry({
          home,
          cwd: home,
          store: openPluginStore({ backend: "jsonl", root: storeRoot }),
        });
  const flowOf = (name: string) => {
    const found = registry.flow(name);
    if (found === undefined) throw new Error(`no flow ${name}`);
    return found.flow;
  };
  return {
    home,
    dir,
    log,
    registry,
    flowOf,
    async start(flow: string, name: string): Promise<string> {
      return (await log.startRun(flow, `job:${name}`)).runId;
    },
    runner(flow: string, runId: string, timer: FakeTimer, access?: Record<string, unknown>) {
      return new Runner({
        log,
        flow: flowOf(flow),
        runId,
        registry,
        lockRoot: storeRoot,
        params: { dir },
        askTimer: timer.timer,
        ...(access === undefined ? {} : { access: access as never }),
      });
    },
    read(name: string): Record<string, unknown> {
      return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    },
  };
}

/** Runs the fake harness until its question times out, then answers it. */
async function askAndAnswer(env: Awaited<ReturnType<typeof setup>>, choice: string) {
  const id = await env.start("resume-flow", "r");
  const timer = new FakeTimer();
  const first = env.runner("resume-flow", id, timer).run();
  await timer.armed();
  timer.fire();
  expect(await first).toBe("waiting");
  await answerRun({
    log: env.log,
    flow: env.flowOf("resume-flow"),
    runId: id,
    choice,
    actor: ACTOR,
  });
  return id;
}

for (const mode of ["memory", "file"] as const) {
  describe(`ask resume (${mode})`, () => {
    test("the step runs again with the session, the answer and a one-time permission", async () => {
      const env = await setup(mode);
      try {
        const id = await askAndAnswer(env, "yes");
        expect((await readState(env.log, id)).status).toBe("running");
        await env.runner("resume-flow", id, new FakeTimer()).run();

        const seen = env.read("second-run.json");
        expect(seen.resumeSession).toBe("sess-1");
        expect(seen.askAnswer).toEqual({ prompt: "Run rm -rf build?", choice: "yes" });
        const grants = seen.grants as Record<string, unknown>[];
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ kind: "command", value: "rm -rf build" });
        // The granted call goes through once; the same call again and a
        // different call are refused.
        expect(seen.outcomes).toEqual(["granted", "refused", "refused"]);

        const list = await facts(env.log, id);
        const used = list.filter((fact) => fact.kind === "grant_used");
        expect(used).toHaveLength(1);
        expect(used[0]?.payload).toMatchObject({ waitId: grants[0]?.waitId, value: "rm -rf build" });
        // The fact is written before the step ends, so before the call returned.
        const ended = list.findLastIndex(
          (fact) =>
            fact.kind === "step_result" &&
            typeof fact.payload === "object" &&
            fact.payload !== null &&
            !Array.isArray(fact.payload) &&
            fact.payload.data !== undefined,
        );
        expect(list.findIndex((fact) => fact.kind === "grant_used")).toBeLessThan(ended);
        const words: string[] = [];
        for await (const entry of historyEntries(env.log.read(id))) words.push(entry.what);
        expect(words).toContain("let one call through that you approved");
      } finally {
        await env.log.close();
      }
    }, 30_000);

    test("a choice that does not approve gives no permission", async () => {
      const env = await setup(mode);
      try {
        const id = await askAndAnswer(env, "no");
        // "no" ends the flow in the fixture; nothing carried a grant.
        expect((await readState(env.log, id)).status).toBe("ended");
        expect((await facts(env.log, id)).some((fact) => fact.kind === "grant_used")).toBe(false);
      } finally {
        await env.log.close();
      }
    }, 30_000);

    test("a step that cannot resume has its question forced to reject_once", async () => {
      const env = await setup(mode);
      try {
        const id = await env.start("plain-flow", "p");
        const timer = new FakeTimer();
        expect(await env.runner("plain-flow", id, timer).run()).toBe("ended");
        const list = await facts(env.log, id);
        const result = list.find((fact) => fact.kind === "step_result");
        expect(result?.payload).toMatchObject({ result: "done", data: { rejected: true } });
        expect(list.some((fact) => fact.kind === "ask_refused")).toBe(false);
        expect(list.some((fact) => fact.kind === "waiting_for_person")).toBe(false);
      } finally {
        await env.log.close();
      }
    }, 30_000);
  });
}

describe("a one-time permission survives a crash", () => {
  test("a crash right after grant_used does not give the permission twice", async () => {
    const env = await setup("file");
    try {
      const id = await askAndAnswer(env, "yes");
      const spawn = (crash: "grant-used" | "none", recover: boolean) =>
        Bun.spawn(
          [
            process.execPath,
            childPath,
            env.home,
            id,
            JSON.stringify({ dir: env.dir }),
            crash,
            ...(recover ? ["recover"] : []),
          ],
          { stdio: ["ignore", "inherit", "inherit"] },
        ).exited;

      expect(await spawn("grant-used", false)).not.toBe(0);
      // The fact is there; the call it was for never ran.
      expect((await facts(env.log, id)).filter((f) => f.kind === "grant_used")).toHaveLength(1);
      expect(existsSync(join(env.dir, "granted-call"))).toBe(false);

      expect(await spawn("none", true)).toBe(0);
      const seen = env.read("second-run.json");
      expect(seen.outcomes).toEqual(["refused", "refused", "refused"]);
      expect(existsSync(join(env.dir, "granted-call"))).toBe(false);
      expect((await facts(env.log, id)).filter((f) => f.kind === "grant_used")).toHaveLength(1);
    } finally {
      await env.log.close();
    }
  }, 60_000);

  test("using a permission twice, from two callers, succeeds once", async () => {
    const env = await setup("memory");
    try {
      const id = await env.start("resume-flow", "g");
      const grants = [{ waitId: "w1", kind: "command" as const, value: "x" }];
      const results = await Promise.all([
        useGrant(env.log, id, "agent", grants, "w1"),
        useGrant(env.log, id, "agent", grants, "w1"),
        useGrant(env.log, id, "agent", grants, "other"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results[2]).toBe(false);
    } finally {
      await env.log.close();
    }
  });
});

test("resumable must be true or false", () => {
  const bad = definePlugin({
    name: "bad",
    kind: "domain",
    version: "0.0.1",
    steps: [
      {
        name: "s",
        results: ["done"],
        resumable: "yes" as never,
        run: () => ({ result: "done" }),
      },
    ],
  });
  expect(
    () => new PluginRegistry([bad], { home: "/x", store: new MemoryPluginStore({ root: "/x" }) }),
  ).toThrow(/resumable: must be true or false/);
});
