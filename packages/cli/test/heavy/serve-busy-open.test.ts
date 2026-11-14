import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { openConfigLog, openPluginStore, readConfig, storeRootOf } from "../../../engine/src/index.ts";
import { waitForChange } from "../../../engine/src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));
const HOLD_CHILD = fileURLToPath(
  new URL("../../../engine/test/fixtures/sqlite-hold.ts", import.meta.url),
);


/** Reads the output of a process as it arrives, so a test waits on a line, not a duration. */
class Output {
  text = "";
  private readonly waiters: Array<() => void> = [];

  constructor(
    child: Bun.Subprocess<"ignore", "pipe", "pipe">,
    ...streams: ReadableStream<Uint8Array>[]
  ) {
    for (const stream of streams) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          this.text += decoder.decode(chunk, { stream: true });
          this.wake();
        }
      })();
    }
    void child.exited.then(() => this.wake());
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** Waits for `pattern`, or reports that the child ended first. */
  async untilOrExit(
    pattern: RegExp,
    child: Bun.Subprocess<"ignore", "pipe", "pipe">,
    deadline: number,
  ): Promise<"line" | "exit"> {
    for (;;) {
      if (pattern.test(this.text)) return "line";
      if (child.exitCode !== null) return "exit";
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${pattern}; got:\n${this.text}`);
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        };
        timer = setTimeout(wake, remaining);
        this.waiters.push(wake);
      });
    }
  }
}

/** Resolves once the file exists. */
async function waitForFile(path: string, deadline: number): Promise<void> {
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await waitForChange(dirname(path), basename(path), 200);
  }
}

/** Reads one line from the holder's stdout. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) text += decoder.decode(value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) {
      reader.releaseLock();
      return text.slice(0, newline);
    }
    if (done) {
      reader.releaseLock();
      return text;
    }
  }
}

/** Declares an object type, so opening the plugin store writes; a tick starts an un-awaited write. */
function pluginSource(work: string): string {
  return `
import { definePlugin } from ${JSON.stringify(ENGINE)};
import { existsSync, writeFileSync } from "node:fs";

const WORK = ${JSON.stringify(work)};

export default definePlugin({
  name: "busystore",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  async onTick(ctx) {
    if (!existsSync(WORK + "/request") || existsSync(WORK + "/requested")) return;
    writeFileSync(WORK + "/requested", "");
    // Nobody waits for this write: a busy store surfaces as a rejection outside any pass.
    void (async () => {
      await ctx.store.put("job", "late", { title: "late" }, "test");
    })();
  },
});
`;
}

async function holdWriteLock(path: string): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
  const holder = Bun.spawn([process.execPath, HOLD_CHILD], {
    env: { ...process.env, OPERAD_DB_PATH: path },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(JSON.parse(await firstLine(holder.stdout))).toEqual({ locked: true });
  return holder;
}

async function release(holder: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
  holder.stdin.write("release\n");
  await holder.stdin.end();
  expect(await holder.exited).toBe(0);
}

async function setup(): Promise<{ home: string; work: string; pluginStore: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, "busystore.ts"), pluginSource(work));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [join(home, "busystore.ts")],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      http: { enabled: false },
    }),
  );
  writeFileSync(join(home, "triggers.json"), "[]\n");
  // The plugin store exists before the holder locks it.
  const config = await readConfig(home);
  const store = openPluginStore({ backend: config.store.backend, root: storeRootOf(config), follow: false });
  if ("close" in store && typeof store.close === "function") store.close();
  return { home, work, pluginStore: join(storeRootOf(config), "plugins.sqlite") };
}

describe("serve opens and runs while another process holds a store's write lock", () => {
  test("waits for the store to open, and goes on after a busy write outside a pass", async () => {
    const { home, work, pluginStore } = await setup();
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: testEnv({ OPERAD_HOME: home, OPERAD_SERVE_INTERVAL_MS: "100" }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Output(serve, serve.stdout, serve.stderr);
    const deadline = Date.now() + 50_000;
    let holder: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    try {
      // The store is locked before serve opens it: declaring the plugin's type needs the lock.
      holder = await holdWriteLock(pluginStore);
      const opened = await output.untilOrExit(
        /^serve: opening the stores: database is locked; trying again$/m,
        serve,
        deadline,
      );
      if (opened === "exit") throw new Error(`serve ended on the busy store:\n${output.text}`);
      await release(holder);
      holder = undefined;
      expect(await output.untilOrExit(/^serving /m, serve, deadline)).toBe("line");

      // A write nobody awaits meets the lock past the busy timeout.
      holder = await holdWriteLock(pluginStore);
      writeFileSync(join(work, "request"), "");
      const background = await output.untilOrExit(
        /^serve: serving \(background\): database is locked.*going on$/m,
        serve,
        deadline,
      );
      if (background === "exit") throw new Error(`serve ended on the busy store:\n${output.text}`);
      expect(serve.exitCode).toBeNull();
      await release(holder);
      holder = undefined;
      expect(readFileSync(join(home, "serve.log"), "utf8")).toContain("serving (background): database is locked");
      expect(serve.exitCode).toBeNull();
    } finally {
      if (holder !== undefined && holder.exitCode === null) {
        holder.kill("SIGKILL");
        await holder.exited;
      }
      if (serve.exitCode === null) serve.kill("SIGTERM");
      await serve.exited;
    }
  }, 70_000);

  test("an error that ends serve names its operation, with the stack in serve.log", async () => {
    const { home, pluginStore } = await setup();
    const database = new Database(pluginStore);
    database.run("UPDATE schema_version SET version = 999 WHERE id = 1");
    database.close();
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: testEnv({ OPERAD_HOME: home }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([serve.exited, new Response(serve.stderr).text()]);
    expect(code).toBe(1);
    expect(err).toMatch(/^operad: serve: opening the stores: plugin store .* schema_version 999/m);
    expect(err).not.toContain("    at ");
    const log = readFileSync(join(home, "serve.log"), "utf8");
    expect(log).toContain("serve: opening the stores:");
    expect(log).toMatch(/^ {4}at .*packages\/engine\/src\/plugin\/sqlite-store\.ts/m);
  }, 30_000);
});
