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
      expect(message).toContain(join(home, "serve.log"));
      expect(message).toContain("boom: the store is locked");
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
