/**
 * The probe ADR 0023 D11 names: `ModelRuntime.login`'s OAuth callback works in
 * a Bun child process, and a pasted redirect URL is the fallback when the
 * callback port is taken. It runs offline; only the token exchange is faked.
 */

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots } from "../../../process/test/support.ts";

afterAll(cleanupTempRoots);

const CHILD = fileURLToPath(new URL("../oauth-probe-child.ts", import.meta.url));

interface Probe {
  readonly ok: boolean;
  readonly accountId: string | null;
  readonly tokenCalls: number;
  readonly callbackStatus: number | null;
  readonly path: "callback" | "manual";
  readonly free: boolean;
}

function runProbe(): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter((item) => item.startsWith("{")).at(-1);
      if (code !== 0 || line === undefined) {
        reject(new Error(`the oauth probe exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as Probe);
      } catch (error) {
        reject(new Error(`the oauth probe printed no JSON: ${String(error)}: ${line}`));
      }
    });
  });
}

test("the ChatGPT OAuth callback completes a login in a Bun child process", async () => {
  const probe = await runProbe();
  expect(probe.ok).toBe(true);
  expect(probe.accountId).toBe("acct_probe");
  expect(probe.tokenCalls).toBe(1);
  if (probe.path === "callback") {
    expect(probe.callbackStatus).toBe(200);
  } else {
    // The port was taken by another program; the pasted redirect URL is the
    // flow's own fallback, and the login still completes.
    expect(probe.free).toBe(false);
  }
}, 30_000);
