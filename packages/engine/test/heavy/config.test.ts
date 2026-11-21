import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot, waitForFile } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const ENABLE_CHILD = join(import.meta.dir, "..", "fixtures", "config-enable-child.ts");
const ADD_CHILD = join(import.meta.dir, "..", "fixtures", "config-add-child.ts");
const ENSURE_CHILD = join(import.meta.dir, "..", "fixtures", "config-ensure-child.ts");
const TWO_WRITERS_CHILD = join(import.meta.dir, "..", "fixtures", "config-two-writers-child.ts");

const CONFIG = `${JSON.stringify(
  {
    store: { path: "s" },
    plugins: {
      dev: { module: "@operad-io/dev", enabled: true },
      shell: { module: "@operad-io/shell", enabled: true },
    },
  },
  null,
  2,
)}\n`;

const WITHOUT_PLUGINS = `${JSON.stringify({ store: { path: "s" } }, null, 2)}\n`;

async function homeWithConfig(text = CONFIG): Promise<{
  readonly home: string;
  readonly file: string;
}> {
  const home = join(await tempRoot(), "home");
  const file = join(home, "config.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(file, text);
  return { home, file };
}

/** Waits for the child's first line, so the parent kills it at a known point. */
async function firstLine(child: {
  readonly stdout: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const next = await reader.read();
    if (next.done === true) throw new Error(`the child ended without a line: ${text}`);
    text += decoder.decode(next.value, { stream: true });
  }
  return text.slice(0, text.indexOf("\n"));
}

/** Kills the child once it reaches the atomic rename; anything else is a failure. */
async function killAtRename(child: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<number>;
}): Promise<void> {
  const line = await firstLine(child);
  if (line !== "ready") {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(
      `the write did not reach the atomic rename: ${await new Response(child.stderr).text()}`,
    );
  }
  child.kill("SIGKILL");
  await child.exited;
}

function temporaryFiles(home: string): readonly string[] {
  return readdirSync(home).filter((name) => name.includes(".tmp"));
}

describe("writing config.json whole", () => {
  test("a writer killed before the rename leaves the old config whole", async () => {
    const { home, file } = await homeWithConfig();
    await killAtRename(Bun.spawn([process.execPath, ENABLE_CHILD, home, "dev"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }));
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
  });

  test("adding a plugin entry writes the file atomically", async () => {
    const { home, file } = await homeWithConfig();
    await killAtRename(Bun.spawn([process.execPath, ADD_CHILD, home, "pool", "@operad-io/pool"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }));
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
  });

  test("filling a missing plugins section writes the file atomically", async () => {
    const { home, file } = await homeWithConfig(WITHOUT_PLUGINS);
    await killAtRename(Bun.spawn([process.execPath, ENSURE_CHILD, home], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }));
    expect(readFileSync(file, "utf8")).toBe(WITHOUT_PLUGINS);
  });

  test("two writers at once both leave valid JSON", async () => {
    const { home, file } = await homeWithConfig();
    const firstReady = join(home, "first.ready");
    const secondReady = join(home, "second.ready");
    const go = join(home, "go");
    const deadline = Date.now() + 5_000;
    const children = [
      Bun.spawn([process.execPath, TWO_WRITERS_CHILD, home, "dev", firstReady, go], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
      Bun.spawn([process.execPath, TWO_WRITERS_CHILD, home, "shell", secondReady, go], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    ];
    await Promise.all([
      waitForFile(firstReady, deadline),
      waitForFile(secondReady, deadline),
    ]);
    const temporaries = [readFileSync(firstReady, "utf8"), readFileSync(secondReady, "utf8")];
    expect(temporaries[0]).not.toBe(temporaries[1]);

    writeFileSync(go, "go\n");
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);

    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    expect(Object.keys(parsed.plugins).sort()).toEqual(["dev", "shell"]);
    expect([parsed.plugins.dev?.enabled, parsed.plugins.shell?.enabled].filter((enabled) => enabled === false)).toHaveLength(1);
    expect(temporaryFiles(home)).toEqual([]);
  });
});
