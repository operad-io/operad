import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "@operad-io/engine/testing";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { testEnv } from "../env.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** The pi operad would have installed in the home, so a new home needs no network. */
function homePi(home: string): void {
  const dir = join(home, "plugins", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.6.0",
      exports: { ".": "./dist/index.js" },
      bin: { pi: "dist/cli.js" },
    }),
  );
  writeFileSync(join(dir, "dist", "index.js"), "export const marker = 1;\n");
  executable(join(dir, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
}

interface Started {
  /** What `operad pending --json` prints while serve runs. */
  readonly pending: readonly { readonly runId: string }[];
  readonly serveErrors: string;
  /** What `operad doctor` prints while serve runs. */
  readonly doctor: string;
  readonly plugins: readonly string[];
}

/** Runs `init`, then `serve` as a real process on the new home, and asks what waits. */
async function freshHome(agents: Readonly<Record<string, string>>, prepare: (home: string) => void): Promise<Started> {
  const root = await tempRoot();
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  symlinkSync(process.execPath, join(bin, "bun"));
  for (const [name, script] of Object.entries(agents)) executable(join(bin, name), script);
  prepare(home);
  const env = {
    ...testEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: root }),
    OPERAD_HOME: home,
    OPERAD_SERVE_INTERVAL_MS: "200",
  };
  const run = async (args: readonly string[], codes: readonly number[] = [0]): Promise<string> => {
    const child = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(codes).toContain(await child.exited);
    expect({ args, err }).toEqual({ args, err: "" });
    return out;
  };
  await run(["init"]);
  const file = join(home, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as { plugins: Record<string, unknown>; http: { port: number } };
  config.http.port = await freePort();
  writeFileSync(file, JSON.stringify(config));

  const serve = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, "serve"], env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const errors = new Response(serve.stderr).text();
  try {
    const reader = serve.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("serving ")) {
      const read = await reader.read();
      if (read.done) throw new Error(`serve ended before it was serving: ${seen}${await errors}`);
      seen += decoder.decode(read.value, { stream: true });
    }
    reader.releaseLock();
    const pending = JSON.parse(await run(["pending", "--json"])) as { runId: string }[];
    const doctor = await run(["doctor"], [0, 1]);
    await run(["serve", "stop"]);
    await serve.exited;
    return { pending, doctor, serveErrors: await errors, plugins: Object.keys(config.plugins) };
  } finally {
    serve.kill("SIGKILL");
    await serve.exited;
  }
}

describe("serve on a new home with nothing set up", () => {
  test("with no agent but operad's pi and no token, only the bot's login waits", async () => {
    const started = await freshHome({}, homePi);
    expect(started.plugins).toEqual(expect.arrayContaining(["telegram", "dev", "pool", "terminal", "codex", "radian"]));
    expect(started.doctor).toContain("ok       plugin terminal is loaded");
    expect(started.serveErrors).toBe("");
    // The login of the one agent the home has; nothing from the plugins that are not set up.
    expect(started.pending.map((item) => item.runId)).toEqual(["bot:login:default"]);
  });

  test("with only a signed-in claude, nothing waits: the pi that is not there asks for no login", async () => {
    const claude = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.1.319 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then printf \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\\n\'; exit 0; fi',
      "exit 1",
      "",
    ].join("\n");
    const started = await freshHome({ claude }, () => undefined);
    expect(started.plugins).toContain("pi");
    expect(started.doctor).toContain("ok       plugin terminal is loaded");
    expect(started.serveErrors).toBe("");
    expect(started.pending).toEqual([]);
    expect(started.doctor).toContain("ok       agent pi is not set up: ");
    expect(started.doctor).not.toContain("problem  agent");
  });
});
