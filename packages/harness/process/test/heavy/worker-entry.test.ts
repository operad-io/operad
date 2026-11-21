import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

const CHILD = fileURLToPath(new URL("../fixtures/worker-entry-stream-error.ts", import.meta.url));

test("a worker entry survives a host that closes stdout", async () => {
  const root = await tempRoot();
  const go = join(root, "go");
  const child = Bun.spawn([process.execPath, CHILD, go], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const stdin = child.stdin;
    if (stdin === null) throw new Error("the child has no stdin pipe");
    stdin.write(`${JSON.stringify({ go })}\n`);
    stdin.end();

    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let first = "";
    while (!first.includes("\n")) {
      const next = await reader.read();
      if (next.done === true) throw new Error(`the child ended before its first line: ${first}`);
      first += decoder.decode(next.value, { stream: true });
    }
    expect(first.trim()).toBe('{"type":"first"}');
    await reader.cancel();

    writeFileSync(go, "go\n");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
