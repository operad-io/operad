import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setPluginEnabled } from "../../src/index.ts";
import type { AsyncAtomicWriteOptions } from "../../src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const CHILD = join(import.meta.dir, "..", "fixtures", "config-enable-child.ts");

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

async function homeWithConfig(): Promise<{ readonly home: string; readonly file: string }> {
  const home = join(await tempRoot(), "home");
  const file = join(home, "config.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(file, CONFIG);
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

describe("enabling a plugin writes config.json whole", () => {
  test("a writer killed before the rename leaves the old config whole", async () => {
    const { home, file } = await homeWithConfig();
    const child = Bun.spawn([process.execPath, CHILD, home, "dev"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
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
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  test("two writers at once both leave valid JSON", async () => {
    const { home, file } = await homeWithConfig();
    let arrived = 0;
    let release: () => void = () => undefined;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const hooks: AsyncAtomicWriteOptions = { beforeRename: gate };
    await Promise.all([
      setPluginEnabled(home, "dev", false, { optional: {} }, hooks),
      setPluginEnabled(home, "shell", false, { optional: {} }, hooks),
    ]);
    expect(arrived).toBe(2);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      plugins?: unknown;
    };
    expect(typeof parsed.plugins).toBe("object");
  });
});
