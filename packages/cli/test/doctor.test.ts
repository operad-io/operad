import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, serveLockPath } from "@operad-io/engine";
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

  test("an agent that is not set up is no problem, unless no agent is set up", async () => {
    const missing = { name: "codex", notSetUp: "codex is not on PATH" };
    const some = await runDoctor(
      healthy({ agents: async () => [{ name: "claude", signedIn: true }, missing] }),
    );
    expect(some.ok).toBe(true);
    expect(formatDoctor(some)).toContain("ok       agent codex is not set up: codex is not on PATH\n");
    const none = await runDoctor(healthy({ agents: async () => [missing] }));
    expect(none.ok).toBe(false);
    expect(formatDoctor(none)).toContain("problem  no agent is set up -> operad plugin enable pi\n");
  });

  test("a listen address this machine lacks is warned about, and is a problem only when none is left", async () => {
    const some = await runDoctor(
      healthy({ listenAddresses: async () => ({ present: ["127.0.0.1"], missing: ["100.71.164.8"] }) }),
    );
    expect(some.ok).toBe(true);
    expect(formatDoctor(some)).toContain(
      "ok       100.71.164.8 is not on this machine now; serve does not listen there; restart serve once it is\n",
    );
    const none = await runDoctor(
      healthy({ listenAddresses: async () => ({ present: [], missing: ["100.71.164.8"] }) }),
    );
    expect(none.ok).toBe(false);
    expect(formatDoctor(none)).toContain(
      "problem  100.71.164.8 is not on this machine now; there is no address left to listen on -> operad serve\n",
    );
  });

  test("an address serve does not answer on is warned about, though this machine has it", async () => {
    const report = await runDoctor(
      healthy({
        serve: async () => ({ answering: true, silent: ["100.71.164.8"] }),
        listenAddresses: async () => ({ present: ["127.0.0.1", "100.71.164.8"], missing: [] }),
      }),
    );
    expect(report.ok).toBe(true);
    expect(formatDoctor(report)).toContain(
      "ok       100.71.164.8 is on this machine but serve does not answer there; restart serve if the address came back after serve started\n",
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

  test("a real home with a missing address listed first asks serve on the next one and warns", async () => {
    const home = await tempRoot("doctor-listen-");
    // The last Tailscale address, which this machine does not have.
    const absent = "100.127.255.254";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    // Doctor asks serve only while the home's serve lock is held.
    const lock = acquireLock(serveLockPath(home));
    // A test host set where the tests run would be reached over ssh.
    const testHost = process.env.OPERAD_CHECK_HOST;
    delete process.env.OPERAD_CHECK_HOST;
    const doctor = async (enabled: boolean) => {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ plugins: [], http: { enabled, port: server.port, listen: [absent, "127.0.0.1"] } }),
      );
      const out = capture();
      await main(["doctor", "--json"], { io: out.io, home });
      return (JSON.parse(out.text()) as { checks: { id: string; ok: boolean; message: string }[] }).checks;
    };
    try {
      const checks = await doctor(true);
      expect(checks).toContainEqual({ id: "serve", ok: true, message: "serve is answering" });
      expect(checks).toContainEqual({
        id: `listen:${absent}`,
        ok: true,
        message: `${absent} is not on this machine now; serve does not listen there; restart serve once it is`,
      });
      // With the interface off, no address is expected to be listened on.
      expect((await doctor(false)).some((check) => check.id.startsWith("listen"))).toBe(false);
    } finally {
      if (testHost !== undefined) process.env.OPERAD_CHECK_HOST = testHost;
      lock.release();
      await server.stop(true);
    }
  });

  /** Runs the real doctor on a home whose serve lock is held, with a server on `127.0.0.1` only. */
  async function doctorOn(listen: readonly string[], enabled = true) {
    const home = await tempRoot("doctor-bound-");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const lock = acquireLock(serveLockPath(home));
    const testHost = process.env.OPERAD_CHECK_HOST;
    delete process.env.OPERAD_CHECK_HOST;
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ plugins: [], http: { enabled, port: server.port, listen } }),
      );
      const out = capture();
      await main(["doctor", "--json"], { io: out.io, home });
      return (JSON.parse(out.text()) as {
        checks: { id: string; ok: boolean; message: string; next?: string }[];
      }).checks;
    } finally {
      if (testHost !== undefined) process.env.OPERAD_CHECK_HOST = testHost;
      lock.release();
      await server.stop(true);
    }
  }

  test("a real home names an address this machine has where serve does not listen", async () => {
    // Loopback is always there; the server listens on the IPv4 one only. It is listed first.
    const checks = await doctorOn(["::1", "127.0.0.1"]);
    expect(checks).toContainEqual({ id: "serve", ok: true, message: "serve is answering" });
    expect(checks.filter((check) => check.id.startsWith("listen"))).toEqual([
      {
        id: "listen:::1",
        ok: true,
        message:
          "::1 is on this machine but serve does not answer there; restart serve if the address came back after serve started",
      },
    ]);
  });

  test("a real home with the interface off names no address where serve does not answer", async () => {
    // A serve still running from before answers on one address and not on the other.
    const checks = await doctorOn(["::1", "127.0.0.1"], false);
    expect(checks).toContainEqual({ id: "serve", ok: true, message: "serve is answering" });
    expect(checks.filter((check) => check.id.startsWith("listen"))).toEqual([]);
  });

  test("a real home with an entry serve refuses reports the refusal, not a missing address", async () => {
    for (const [entry, reason] of [
      ["nonsense", 'http.listen: "nonsense" is not an IP address'],
      ["0.0.0.0", 'http.listen: "0.0.0.0" is a wildcard address; name each address to listen on'],
    ] as const) {
      const checks = await doctorOn(["127.0.0.1", entry]);
      expect(checks.filter((check) => check.id.startsWith("listen"))).toEqual([
        { id: "listen", ok: false, message: reason, next: "operad doctor" },
      ]);
    }
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
