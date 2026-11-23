import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatDoctor, runDoctor, type DoctorEnv } from "../src/doctor.ts";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

/** An environment where everything is fine; a test overrides one fact. */
function healthy(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    homeExists: () => true,
    config: async () => ({ present: true }),
    plugins: async () => [
      { name: "chat", loaded: true },
      { name: "claude", loaded: true },
    ],
    agents: async () => [{ name: "claude", version: "2.1.330", signedIn: true }],
    serve: async () => ({ answering: true }),
    testHost: async () => undefined,
    setup: async () => [],
    ...over,
  };
}

function capture(): { io: CliIo; text(): string } {
  let out = "";
  return {
    io: { write: (text) => void (out += text), error: () => undefined },
    text: () => out,
  };
}

describe("operad doctor", () => {
  test("all good: one ok line per fact and no problem", async () => {
    const report = await runDoctor(healthy());
    expect(report.ok).toBe(true);
    expect(formatDoctor(report)).toBe(
      [
        "ok       home and config.json are valid",
        "ok       plugin chat is loaded",
        "ok       plugin claude is loaded",
        "ok       agent claude 2.1.330, signed in",
        "ok       serve is answering",
        "",
      ].join("\n"),
    );
  });

  test("git not installed is an ok line with a note, and an installed git adds no line", async () => {
    const without = await runDoctor(healthy({ gitInstalled: () => false }));
    expect(without.ok).toBe(true);
    expect(formatDoctor(without)).toContain("ok       git is not installed: chat works without it, and a task needs it\n");
    const installed = await runDoctor(healthy({ gitInstalled: () => true }));
    expect(installed.checks.some((check) => check.id === "git")).toBe(false);
  });

  test("dev on with pool off: the setup problem ends with the command to type", async () => {
    const prompt =
      "plugin pool is not loaded and dev runs its workers through it: run `operad plugin enable pool` and restart serve";
    const report = await runDoctor(
      healthy({ setup: async () => [{ id: "dev:plugin:pool", prompt }] }),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toEqual({ id: "setup:dev:plugin:pool", ok: false, message: prompt, next: "operad plugin enable pool" });
    expect(formatDoctor(report)).toContain(`problem  ${prompt}`);
  });

  test("a setup problem with no command points at operad pending", async () => {
    const report = await runDoctor(
      healthy({ setup: async () => [{ id: "dev:settings:app", prompt: "settings are not valid" }] }),
    );
    expect(report.checks.at(-1)?.next).toBe("operad pending");
  });

  test("an agent that is not signed in names the sign-in command", async () => {
    const report = await runDoctor(
      healthy({ agents: async () => [{ name: "claude", version: "2.1.330", signedIn: false }] }),
    );
    expect(report.ok).toBe(false);
    expect(formatDoctor(report)).toContain(
      "problem  agent claude 2.1.330 is not signed in -> claude auth login",
    );
  });

  test("an agent operad can log in gets operad bot:login, and --json carries the same next", async () => {
    const env = healthy({
      agents: async () => [{ name: "pi", signedIn: false, loginBot: "default" }],
    });
    const report = await runDoctor(env);
    expect(formatDoctor(report)).toContain(
      "problem  agent pi is not signed in -> operad bot:login default",
    );
    const out = capture();
    expect(await main(["doctor", "--json"], { io: out.io, home: "/nowhere", doctor: env })).toBe(1);
    const json = JSON.parse(out.text()) as { checks: { id: string; next?: string }[] };
    expect(json.checks.find((check) => check.id === "agent:pi")?.next).toBe(
      "operad bot:login default",
    );
  });

  test("an agent operad cannot log in keeps its own command", async () => {
    const report = await runDoctor(
      healthy({ agents: async () => [{ name: "radian", signedIn: false }] }),
    );
    expect(formatDoctor(report)).toContain(
      "problem  agent radian is not signed in -> radian login",
    );
  });

  test("serve not answering names operad serve", async () => {
    const report = await runDoctor(healthy({ serve: async () => ({ answering: false }) }));
    expect(report.ok).toBe(false);
    expect(formatDoctor(report)).toContain("problem  serve is not answering -> operad serve");
  });

  test("a plugin that did not load says why and how to turn it off", async () => {
    const report = await runDoctor(
      healthy({ plugins: async () => [{ name: "dev", loaded: false, problem: "cannot import" }] }),
    );
    expect(formatDoctor(report)).toContain(
      "problem  plugin dev did not load: cannot import -> operad plugin disable dev",
    );
  });

  test("a test host that does not answer is a problem; one that does is a line", async () => {
    const down = await runDoctor(
      healthy({ testHost: async () => ({ host: "build", reachable: false }) }),
    );
    expect(formatDoctor(down)).toContain("problem  test host build is not reachable -> ssh build");
    const up = await runDoctor(
      healthy({ testHost: async () => ({ host: "build", reachable: true }) }),
    );
    expect(up.ok).toBe(true);
    expect(formatDoctor(up)).toContain("ok       test host build is reachable");
  });

  test("a broken config.json is one problem and the rest is not loaded", async () => {
    let loaded = false;
    const report = await runDoctor(
      healthy({
        config: async () => {
          throw new Error("invalid JSON");
        },
        plugins: async () => {
          loaded = true;
          return [];
        },
      }),
    );
    expect(loaded).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toBe("config.json is not valid: invalid JSON");
    expect(report.checks[0]?.next).toBe("operad doctor");
  });

  test("--json carries the same facts and the exit code follows them", async () => {
    const good = capture();
    expect(
      await main(["doctor", "--json"], { io: good.io, home: "/nowhere", doctor: healthy() }),
    ).toBe(0);
    expect(JSON.parse(good.text())).toMatchObject({
      ok: true,
      checks: expect.arrayContaining([expect.objectContaining({ id: "home", ok: true })]),
    });

    const bad = capture();
    const code = await main(["doctor", "--json"], {
      io: bad.io,
      home: "/nowhere",
      doctor: healthy({ serve: async () => ({ answering: false }) }),
    });
    expect(code).toBe(1);
    expect(JSON.parse(bad.text())).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        { id: "serve", ok: false, message: expect.any(String), next: "operad serve" },
      ]),
    });
  });

  test("a real home with a broken config.json exits 1 and changes nothing", async () => {
    const home = await tempRoot("doctor-home-");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "{ not json");
    const before = readdirSync(home).sort();
    const out = capture();
    expect(await main(["doctor"], { io: out.io, home })).toBe(1);
    expect(out.text()).toContain("problem  config.json is not valid");
    expect(readdirSync(home).sort()).toEqual(before);
  });

  test("a missing home is reported and not created", async () => {
    const home = join(await tempRoot("doctor-missing-"), "none");
    const out = capture();
    expect(await main(["doctor"], { io: out.io, home })).toBe(1);
    expect(out.text()).toContain("problem  the operad home does not exist -> operad init");
    expect(existsSync(home)).toBe(false);
  });

  test("it takes no arguments", async () => {
    const out = capture();
    const code = await main(["doctor", "now"], {
      io: out.io,
      home: "/nowhere",
      doctor: healthy(),
    });
    expect(code).toBe(2);
  });
});
