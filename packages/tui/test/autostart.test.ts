import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import {
  TuiStartError,
  ensureServer,
  probeServer,
  runTui,
  spawnServe,
  type FetchLike,
  type ServeSpawner,
} from "../src/index.ts";
import { freePort, tempRoot } from "./support.ts";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "cli", "bin", "operad.ts");

async function makeHome(http?: Record<string, unknown>): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [],
      store: { backend: "jsonl", path: join(root, "store") },
      ...(http === undefined ? {} : { http }),
    }),
  );
  return { home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const operad = (): Response => Response.json({ types: [] });
const unauthorized = (): Response =>
  Response.json({ error: { kind: "unauthorized", message: "no token" } }, { status: 401 });

/** A fetch that refuses until `up()` is set, then answers like operad. */
function switchable(): { fetch: FetchLike; up: () => void; calls: () => number } {
  let isUp = false;
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      if (!isUp) throw new Error("connection refused");
      return operad();
    },
    up: () => {
      isUp = true;
    },
    calls: () => calls,
  };
}

const noWait = async (): Promise<void> => undefined;

describe("probeServer", () => {
  test("tells operad, a silent address and another service apart", async () => {
    expect(await probeServer("http://x", async () => operad())).toBe("operad");
    expect(await probeServer("http://x", async () => unauthorized())).toBe("operad");
    expect(await probeServer("http://x", async () => { throw new Error("refused"); })).toBe("silent");
    expect(await probeServer("http://x", async () => new Response("<html>"))).toBe("other");
    expect(await probeServer("http://x", async () => Response.json({ hello: 1 }))).toBe("other");
    expect(await probeServer("http://x", async () => Response.json({ types: [] }, { status: 500 }))).toBe("other");
  });
});

describe("ensureServer", () => {
  test("a fresh home with no config starts serve, waits for it and returns the address", async () => {
    const root = await tempRoot();
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const net = switchable();
      const lines: string[] = [];
      const logs: string[] = [];
      const spawn: ServeSpawner = (log) => {
        logs.push(log);
        net.up();
        return { exited: new Promise(() => undefined) };
      };
      const url = await ensureServer({
        home,
        fetch: net.fetch,
        spawn,
        write: (line) => lines.push(line),
        wait: noWait,
        lockHeld: () => false,
      });
      expect(url).toBe("http://127.0.0.1:7480");
      expect(logs).toEqual([join(home, "serve.log")]);
      expect(lines).toEqual([`starting operad serve (log: ${join(home, "serve.log")})`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a serve that already answers is not started again", async () => {
    const { home, cleanup } = await makeHome();
    try {
      let spawned = 0;
      const lines: string[] = [];
      await ensureServer({
        home,
        fetch: async () => operad(),
        spawn: () => {
          spawned += 1;
          return { exited: new Promise(() => undefined) };
        },
        write: (line) => lines.push(line),
        lockHeld: () => false,
      });
      expect(spawned).toBe(0);
      expect(lines).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("a home lock with a silent port is an error naming http.enabled and http.port, and starts nothing", async () => {
    const { home, cleanup } = await makeHome();
    try {
      let spawned = 0;
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: () => {
          spawned += 1;
          return { exited: new Promise(() => undefined) };
        },
        lockHeld: () => true,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      expect((error as Error).message).toContain("http.enabled");
      expect((error as Error).message).toContain("http.port");
      expect(spawned).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("a child that exits at once is an error naming the log and showing its tail", async () => {
    const { home, cleanup } = await makeHome();
    try {
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: (log) => {
          writeFileSync(log, "starting\nboom: the store is locked\n");
          return { exited: Promise.resolve(1) };
        },
        wait: noWait,
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      const message = (error as Error).message;
      expect(message).toContain("exited at once");
      expect(message).toContain(join(home, "serve.log"));
      expect(message).toContain("boom: the store is locked");
    } finally {
      await cleanup();
    }
  });

  test("a long log's tail keeps the last ten lines and decodes a multi-byte line across reads", async () => {
    const { home, cleanup } = await makeHome();
    try {
      const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
      const long = `${"€".repeat(10_000)} boom`;
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: (log) => {
          writeFileSync(log, `${lines.join("\n")}\n${long}\n`);
          return { exited: Promise.resolve(1) };
        },
        wait: noWait,
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      const message = (error as Error).message;
      expect(message).toContain("line 19");
      expect(message).not.toContain("line 0\n");
      expect(message).toContain("boom");
      expect(message).not.toContain("\uFFFD");
    } finally {
      await cleanup();
    }
  });

  test("a child that cannot listen because the port is taken says the port is in use", async () => {
    const { home, cleanup } = await makeHome();
    try {
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: (log) => {
          writeFileSync(log, "operad: Failed to start server. Is port 7480 in use?\n");
          return { exited: Promise.resolve(1) };
        },
        wait: noWait,
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      const message = (error as Error).message;
      expect(message).toContain("is in use");
      expect(message).toContain("does not answer on http:");
      expect(message).not.toContain("exited at once");
    } finally {
      await cleanup();
    }
  });

  test("a child that lost the home lock to a serve that never answers says that serve runs and does not answer", async () => {
    const { home, cleanup } = await makeHome();
    try {
      let checks = 0;
      let time = 0;
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: (log) => {
          writeFileSync(log, "operad: another serve holds this home\n");
          return { exited: Promise.resolve(4) };
        },
        wait: async (ms) => { time += ms; },
        now: () => time,
        // Free before the start, held once the child has lost the lock.
        lockHeld: () => {
          checks += 1;
          return checks > 1;
        },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      const message = (error as Error).message;
      expect(message).toContain("already runs for this home but does not answer at");
      expect(message).not.toContain("did not answer at");
    } finally {
      await cleanup();
    }
  });

  test("a child that never answers times out with the log and its tail", async () => {
    const { home, cleanup } = await makeHome();
    try {
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: (log) => {
          writeFileSync(log, "still starting\n");
          return { exited: new Promise(() => undefined) };
        },
        wait: noWait,
        now: (() => { let t = 0; return () => (t += 100); })(),
        startTimeoutMs: 300,
        pollMs: 100,
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      const message = (error as Error).message;
      expect(message).toContain("did not answer");
      expect(message).toContain(join(home, "serve.log"));
      expect(message).toContain("still starting");
    } finally {
      await cleanup();
    }
  });

  test("http.enabled false starts nothing and names the key", async () => {
    const { home, cleanup } = await makeHome({ enabled: false });
    try {
      let spawned = 0;
      const error = await ensureServer({
        home,
        fetch: async () => { throw new Error("refused"); },
        spawn: () => {
          spawned += 1;
          return { exited: new Promise(() => undefined) };
        },
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect((error as Error).message).toContain("http.enabled");
      expect(spawned).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("a port that answers but is not operad is an error naming the port", async () => {
    const { home, cleanup } = await makeHome({ port: 7611 });
    try {
      let spawned = 0;
      const error = await ensureServer({
        home,
        fetch: async () => new Response("<html>hello</html>"),
        spawn: () => {
          spawned += 1;
          return { exited: new Promise(() => undefined) };
        },
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect((error as Error).message).toContain("7611");
      expect((error as Error).message).toContain("not operad");
      expect(spawned).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe("ensureServer: races and bounds", () => {
  test("two tui starting at once both end connected to the one serve", async () => {
    const { home, cleanup } = await makeHome();
    try {
      let up = false;
      let waits = 0;
      let spawned = 0;
      let lockChecks = 0;
      const fetchImpl: FetchLike = async () => {
        if (!up) throw new Error("refused");
        return operad();
      };
      const common = {
        home,
        fetch: fetchImpl,
        wait: async (): Promise<void> => {
          waits += 1;
          // Let the other call's file reads run; no time is waited.
          await new Promise<void>((resolve) => setImmediate(resolve));
          // The serve comes up only once both have tried to start one.
          if (waits >= 3 && spawned === 2) up = true;
        },
        // Both see the lock free before either spawns; after that it is held.
        lockHeld: (): boolean => {
          lockChecks += 1;
          return lockChecks > 2;
        },
        spawn: (log: string) => {
          spawned += 1;
          if (spawned === 1) return { exited: new Promise<number | null>(() => undefined) };
          // The loser: the lock was taken, so it exits at once.
          writeFileSync(log, "lock held\n");
          return { exited: Promise.resolve(4) };
        },
      };
      const [a, b] = await Promise.all([ensureServer(common), ensureServer(common)]);
      expect(a).toBe("http://127.0.0.1:7480");
      expect(b).toBe(a);
      expect(spawned).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("port 0 or an empty listen fails before anything is spawned", async () => {
    for (const http of [{ port: 0 }, { listen: [] }]) {
      const { home, cleanup } = await makeHome(http);
      try {
        let spawned = 0;
        const error = await ensureServer({
          home,
          fetch: async () => { throw new Error("refused"); },
          spawn: () => {
            spawned += 1;
            return { exited: new Promise(() => undefined) };
          },
          lockHeld: () => false,
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/--url/);
        expect((error as Error).message).toMatch(/http\.(port|listen)/);
        expect(spawned).toBe(0);
      } finally {
        await cleanup();
      }
    }
  });

  test("probe time counts against the start deadline", async () => {
    const { home, cleanup } = await makeHome();
    try {
      let clock = 0;
      let probes = 0;
      const error = await ensureServer({
        home,
        // Each probe takes its whole timeout, then fails.
        fetch: async () => {
          probes += 1;
          clock += 1_500;
          throw new Error("timed out");
        },
        spawn: () => ({ exited: new Promise(() => undefined) }),
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        startTimeoutMs: 15_000,
        pollMs: 100,
        probeTimeoutMs: 1_500,
        lockHeld: () => false,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TuiStartError);
      // One probe before the start, then about 15 s / 1.6 s while waiting.
      expect(probes).toBeLessThanOrEqual(12);
      // The deadline, the probe in flight when it passes, and one wait; the
      // first probe, before the start, is not part of it.
      expect(clock).toBeLessThanOrEqual(1_500 + 15_000 + 1_500 + 100);
    } finally {
      await cleanup();
    }
  });
});

describe("runTui and the flags", () => {
  async function runWith(options: { url?: string; noStart?: boolean }): Promise<number> {
    const test = await createTestRenderer({ width: 60, height: 10 });
    let ensured = 0;
    try {
      await runTui({
        ...options,
        token: "t",
        home: "/nowhere",
        onError: () => undefined,
        hooks: {
          ensure: async () => {
            ensured += 1;
            return "http://127.0.0.1:1";
          },
          renderer: async () => test.renderer,
          view: () => {
            throw new Error("stop here");
          },
        },
      });
      return ensured;
    } finally {
      await test.dispose();
    }
  }

  test("--url and --no-start never start or check a serve; neither does nothing at all", async () => {
    expect(await runWith({ url: "http://127.0.0.1:9" })).toBe(0);
    expect(await runWith({ noStart: true })).toBe(0);
  });
});

describe("a real serve", () => {
  test("a fresh home on a free port: tui starts serve, connects, and the child is stopped after", async () => {
    const port = await freePort();
    const { home, cleanup } = await makeHome({ enabled: true, port, listen: ["127.0.0.1"] });
    let pid: number | undefined;
    let exited: Promise<number | null> | undefined;
    try {
      const real = spawnServe(home, CLI_ENTRY);
      const lines: string[] = [];
      const url = await ensureServer({
        home,
        write: (line) => lines.push(line),
        spawn: (log) => {
          const started = real(log);
          pid = started.pid;
          exited = started.exited;
          return started;
        },
      });
      expect(url).toBe(`http://127.0.0.1:${port}`);
      expect(await probeServer(url)).toBe("operad");
      expect(lines).toHaveLength(1);
      expect(readFileSync(join(home, "serve.log"), "utf8")).toContain("serving");

      // Detached: its own process group, so quitting the TUI does not end it.
      const group = (id: number): string =>
        new TextDecoder()
          .decode(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(id)]).stdout)
          .trim();
      expect(pid).toBeDefined();
      expect(group(pid ?? 0)).not.toBe("");
      expect(group(pid ?? 0)).not.toBe(group(process.pid));

      // The second call finds it running and starts nothing.
      let again = 0;
      await ensureServer({
        home,
        spawn: () => {
          again += 1;
          return { exited: new Promise(() => undefined) };
        },
      });
      expect(again).toBe(0);
    } finally {
      // Stop only the child this test started.
      if (pid !== undefined) process.kill(pid, "SIGTERM");
      await exited;
      await cleanup();
    }
  }, 30_000);
});
