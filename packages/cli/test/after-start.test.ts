// The packages `serve` installs once it is serving (ADR 0012 D4).

import { describe, expect, test } from "bun:test";
import { awaitedPlugins, installAfterStart } from "../src/after-start.ts";

const entry = (name: string) => ({ name, module: `@operad-io/${name}`, enabled: true, settings: {} });

describe("installing after the start", () => {
  test("answers what was newly installed, and nothing for what was there", async () => {
    const installed = await installAfterStart({
      entries: [entry("new"), entry("there")],
      install: async (item) => item.name === "new",
      signal: new AbortController().signal,
      onFailure: async () => undefined,
    });
    expect(installed).toEqual(["new"]);
  });

  test("reports a failure as one line and goes on, without failing", async () => {
    const failures: [string, string][] = [];
    const installed = await installAfterStart({
      entries: [entry("broken"), entry("new")],
      install: async (item) => {
        if (item.name === "broken") throw new Error("no network\n  tried twice");
        return true;
      },
      signal: new AbortController().signal,
      onFailure: async (name, reason) => void failures.push([name, reason]),
    });
    expect(installed).toEqual(["new"]);
    expect(failures).toEqual([["broken", "no network tried twice"]]);
  });

  test("a stop ends it quietly: no report, and nothing more starts", async () => {
    const stop = new AbortController();
    const asked: string[] = [];
    const failures: string[] = [];
    const installed = await installAfterStart({
      entries: [entry("first"), entry("second")],
      install: async (item) => {
        asked.push(item.name ?? "");
        stop.abort();
        throw new Error("killed");
      },
      signal: stop.signal,
      onFailure: async (name) => void failures.push(name),
    });
    expect({ installed, asked, failures }).toEqual({ installed: [], asked: ["first"], failures: [] });
  });
});

describe("the plugins awaiting their install", () => {
  test("are those that are on and have a stand-in loading for them", () => {
    const standIn = "/stand-in/plugin.ts";
    const awaited = awaitedPlugins(
      "/tmp/operad-test-no-home",
      [
        { ...entry("absent"), module: "operad-test-absent" },
        { ...entry("off"), module: "operad-test-off", enabled: false },
        // Its package is here, so it loads as itself.
        entry("engine"),
      ],
      { "operad-test-absent": standIn, "operad-test-off": standIn, "@operad-io/engine": standIn },
    );
    expect([...awaited]).toEqual(["absent"]);
  });

  test("stay while a reload will load them, and leave when none will", async () => {
    const awaited = new Set(["new", "there", "broken"]);
    await installAfterStart({
      entries: [entry("new"), entry("there"), entry("broken")],
      install: async (item) => {
        if (item.name === "broken") throw new Error("no network");
        return item.name === "new";
      },
      signal: new AbortController().signal,
      onFailure: async () => undefined,
      awaited,
    });
    expect([...awaited]).toEqual(["new"]);
  });
});
