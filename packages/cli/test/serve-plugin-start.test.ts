// A real `operad serve` process asked before a plugin has started (ADR 0029 D4).

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHttpToken } from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { SUPERVISED_ENV } from "../src/code-reload.ts";
import { testEnv } from "./env.ts";

afterAll(cleanupTempRoots);

const CLI = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const GATED = fileURLToPath(new URL("./fixtures/gated-plugin.ts", import.meta.url));

const started: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const serve of started.splice(0)) {
    serve.kill("SIGKILL");
    await serve.exited;
  }
});

/** Reads a body until its text matches `pattern`. */
async function readUntil(body: ReadableStream<Uint8Array> | null, pattern: RegExp): Promise<RegExpExecArray> {
  const reader = body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const found = pattern.exec(text);
    if (found !== null) {
      reader?.releaseLock();
      return found;
    }
    const chunk = await reader?.read();
    if (chunk === undefined || chunk.done) throw new Error(`ended without ${String(pattern)}: ${text}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
}

describe("serve before a plugin has started", () => {
  test("says the plugin is starting, and an open stream gets its events once it runs", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { gated: { module: GATED, enabled: true } },
        http: { enabled: true, port: 0, listen: ["127.0.0.1"] },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      }),
    );
    const serve = Bun.spawn({
      cmd: [process.execPath, CLI, "serve"],
      env: testEnv({ HOME: root, OPERAD_HOME: home, [SUPERVISED_ENV]: "1" }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    started.push(serve);
    const url = (await readUntil(serve.stdout, /^http (\S+)\n/m))[1] ?? "";
    const token = (await readHttpToken(home))?.token ?? "";
    const call = (path: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });

    const early = await call("/v1/gated");
    expect({ status: early.status, retry: early.headers.get("retry-after") }).toEqual({ status: 503, retry: "1" });
    const stream = await call("/v1/events?gated=1");
    writeFileSync(join(home, "open-gate"), "");
    await readUntil(stream.body, /event: gated\.hello\n/);
    expect((await call("/v1/gated")).status).toBe(200);
  });
});
