import { describe, expect, test } from "bun:test";
import { testEnv } from "../env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempRoot } from "../../../engine/test/plugin/support.ts";

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));

function runServe(home: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: { ...testEnv(), OPERAD_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

/** Reads the child's stdout until it has printed `text`. */
async function until(child: Bun.Subprocess<"ignore", "pipe", "pipe">, text: string): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(text)) {
    const read = await reader.read();
    if (read.done) throw new Error(`serve ended before it printed "${text}": ${seen}`);
    seen += decoder.decode(read.value, { stream: true });
  }
  reader.releaseLock();
  return seen;
}

describe("a second operad serve", () => {
  test("exits 4 on a held home before it reads the config, the store or the port", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const port = await freePort();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [],
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        http: { enabled: true, port, listen: ["127.0.0.1"] },
      }),
    );
    const first = runServe(home);
    try {
      expect(await until(first, "serving")).toContain(`http http://127.0.0.1:${port}`);

      // A config no later step could read: only the lock, taken first, can
      // explain exit 4 instead of a config error.
      writeFileSync(join(home, "config.json"), "{ not json");
      const second = runServe(home);
      const [code, out, errors] = await Promise.all([
        second.exited,
        new Response(second.stdout).text(),
        new Response(second.stderr).text(),
      ]);
      expect(code).toBe(4);
      expect(errors).toContain("still alive");
      expect(out).not.toContain("http http://");
      expect(out).not.toContain("serving");
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
  }, 30_000);
});
