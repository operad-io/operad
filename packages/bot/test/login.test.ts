/**
 * A bot without a model login (ADR 0030 D14): one standing item, a `login`
 * action, the `bot:login` flow, and the model the agent returns written to the
 * bot's own `model` setting.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Runner,
  definePlugin,
  openLog,
  type PluginStepResult,
  type RunLookup,
} from "@operad-io/engine";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

function loginHarness(options: { readonly signedIn: boolean } = { signedIn: false }) {
  return definePlugin({
    name: "login",
    kind: "harness",
    version: "0.0.0",
    capabilities: { accessLevels: ["ask", "full"] },
    models: { list: ["login/a"], default: "login/a" },
    efforts: { list: [], default: null },
    signedIn: async () => options.signedIn,
    steps: [
      {
        name: "login",
        results: ["done", "failed"],
        run: (): PluginStepResult => ({
          result: "done",
          data: { provider: "login", model: "login/a" },
        }),
      },
    ],
  });
}

function botConfig(home: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    plugins: { bot: { settings: { bots: Record<string, unknown> } } };
  };
  return parsed.plugins.bot.settings.bots;
}

describe("a bot without a model login", () => {
  test("is one standing item for the bot, and its login action starts the login", async () => {
    const events: unknown[] = [];
    const r = await rig(
      { default: { harness: "login" } },
      ["claude", "pi"],
      (event) => events.push(event),
      [loginHarness()],
    );
    const items = await r.registry.standing();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("login:default");
    expect(items[0]?.prompt).toBe('bot "default" is not logged in to a model');
    expect(items[0]?.object).toEqual({ type: "bot", id: "default" });
    expect(items[0]?.actions).toContainEqual({ plugin: "bot", action: "login" });

    const said = await r.act("bot", "default", "login");
    expect(String(said)).toContain("logging in");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "bot",
      type: "login",
      object: "bot:default",
    });
  });

  test("the flow calls the agent's login step and writes the model into the bot's settings", async () => {
    const r = await rig(
      { default: {} },
      ["claude", "pi"],
      undefined,
      [loginHarness()],
    );
    const found = r.registry.flow("bot:login");
    if (found === undefined) throw new Error("the login flow is not loaded");
    const log = openLog({ path: join(r.root, "log", "log.sqlite") });
    try {
      const info = await log.startRun("bot:login", "bot:default");
      const run = new Runner({
        log,
        flow: found.flow,
        runId: info.runId,
        registry: r.registry,
        params: null,
        object: { type: "bot", id: "default" },
      }).run();
      expect(await run).toBe("ended");
      const bot = botConfig(r.home)["default"] as Record<string, unknown>;
      expect(bot["model"]).toBe("login/a");
      expect(bot["harness"]).toBe("login");
    } finally {
      await log.close();
    }
  });

  test("an agent with no login step is not offered one, and the step says why", async () => {
    const r = await rig({ default: { harness: "claude" } });
    const items = await r.registry.standing();
    expect(items).toEqual([]);

    const object = await r.store.get("bot", "default");
    if (object === undefined) throw new Error("no default bot");
    const result = await r.registry.runStep("bot/login", {}, {
      runId: "run-1",
      object: { type: "bot", id: "default", data: object.data },
      cwd: r.root,
      signal: new AbortController().signal,
    });
    expect(result.result).toBe("failed");
    expect(JSON.stringify(result.data)).toContain("no agent of this bot has a login here");
  });

  test("a login run that is still live hides the standing item", async () => {
    const r = await rig(
      { default: { harness: "login" } },
      ["claude", "pi"],
      undefined,
      [loginHarness()],
    );
    const lookup = {
      active: async () => [{ runId: "run-1", flow: "bot:login", object: "bot:default" }],
      state: async () => undefined,
      lastStep: async () => null,
    } as unknown as RunLookup;
    expect((await r.registry.standing(lookup)).map((item) => item.id)).toEqual([]);
    expect((await r.registry.standing()).map((item) => item.id)).toEqual(["login:default"]);
  });

  test("a signed-in agent has no item", async () => {
    const r = await rig(
      { default: { harness: "login" } },
      ["claude", "pi"],
      undefined,
      [loginHarness({ signedIn: true })],
    );
    expect(await r.registry.standing()).toEqual([]);
  });

  test("a bot that names no agent uses the one loaded agent that can log in", async () => {
    const r = await rig({ default: {} }, ["claude", "pi"], undefined, [loginHarness()]);
    const items = await r.registry.standing();
    expect(items.map((item) => item.id)).toEqual(["login:default"]);
  });
});
