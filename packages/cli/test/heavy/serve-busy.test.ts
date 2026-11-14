import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openConfigLog, readConfig } from "../../../engine/src/index.ts";
import { waitForChange } from "../../../engine/src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url));
const HOLD_CHILD = fileURLToPath(
  new URL("../../../engine/test/fixtures/sqlite-hold.ts", import.meta.url),
);

/** The plugin starts a run for each request file once, and writes a file when its step ran. */
function pluginSource(work: string): string {
  return `
import { defineFlow, definePlugin } from ${JSON.stringify(ENGINE)};
import { existsSync, writeFileSync } from "node:fs";

const WORK = ${JSON.stringify(work)};

const flow = defineFlow({
  name: "busy",
  entry: "mark",
  steps: [
    { id: "mark", kind: "plugin", params: { use: "busyflow/mark", params: {} }, replay: "safe", next: { ready: "done" } },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

export default definePlugin({
  name: "busyflow",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  flows: [flow],
  async onTick(ctx) {
    for (const id of ["1", "2"]) {
      const request = WORK + "/request-" + id;
      const requested = WORK + "/requested-" + id;
      if (!existsSync(request) || existsSync(requested)) continue;
      await ctx.start({ flow: "busy", object: { type: "job", id } });
      writeFileSync(requested, "");
    }
  },
  steps: [
    {
      name: "mark",
      results: ["ready"],
      async run(ctx) {
        writeFileSync(WORK + "/served-" + ctx.object.id, "");
        return { result: "ready" };
      },
    },
  ],
});
`;
}

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

/** Resolves once every run of the home has ended. */
async function waitForRunsEnded(home: string, deadline: number): Promise<void> {
  const config = await readConfig(home);
  for (;;) {
    const log = openConfigLog(config, { follow: false });
    try {
      const runs = await log.runs();
      if (runs.length >= 2 && runs.every((run) => !run.active)) return;
    } finally {
      await log.close();
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the runs to end");
    await waitForChange(dirname(config.store.path), basename(config.store.path), 200);
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

describe("serve while another process holds the store's write lock", () => {
  test("logs the busy pass, keeps running, and serves the next run after the lock is released", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const work = join(root, "work");
    const store = join(root, "store", "log.sqlite");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(home, "busyflow.ts"), pluginSource(work));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [join(home, "busyflow.ts")],
        store: { backend: "sqlite", path: store },
        http: { enabled: false },
      }),
    );
    writeFileSync(join(home, "triggers.json"), "[]\n");

    const env = testEnv({
      OPERAD_HOME: home,
      OPERAD_SERVE_INTERVAL_MS: "100",
    });
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Output(serve, serve.stdout, serve.stderr);
    const deadline = Date.now() + 45_000;
    let holder: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    try {
      expect(await output.untilOrExit(/serving /, serve, deadline)).toBe("line");

      holder = Bun.spawn([process.execPath, HOLD_CHILD], {
        env: { ...process.env, OPERAD_DB_PATH: store },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(JSON.parse(await firstLine(holder.stdout))).toEqual({ locked: true });

      // The plugin asks for a run while the holder keeps the write lock past
      // the busy timeout. That pass fails; the serve must not.
      writeFileSync(join(work, "request-1"), "");
      const outcome = await output.untilOrExit(
        /^serve: database is locked; trying again$/m,
        serve,
        deadline,
      );
      if (outcome === "exit") {
        throw new Error(`serve ended on the busy store:\n${output.text}`);
      }
      expect(serve.exitCode).toBeNull();

      holder.stdin.write("release\n");
      await holder.stdin.end();
      expect(await holder.exited).toBe(0);
      holder = undefined;

      // The start request the busy pass could not take is tried again, and a
      // later request is served too.
      await waitForFile(join(work, "served-1"), deadline);
      writeFileSync(join(work, "request-2"), "");
      await waitForFile(join(work, "served-2"), deadline);
      await waitForRunsEnded(home, deadline);
      expect(serve.exitCode).toBeNull();
    } finally {
      if (holder !== undefined && holder.exitCode === null) {
        holder.kill("SIGKILL");
        await holder.exited;
      }
      if (serve.exitCode === null) serve.kill("SIGTERM");
      await serve.exited;
    }
  }, 60_000);
});
