import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPlugin,
  openConfigLog,
  readConfig,
  readHttpToken,
  startHttpServer,
  type HttpServerHandle,
} from "@operad-io/engine";
import { main, openContext, pluginAdminFor, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const demoPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);
const notesPath = fileURLToPath(
  new URL("../../engine/test/fixtures/example-plugin/index.ts", import.meta.url),
);

function capture(): { io: CliIo; out(): string; err(): string } {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

interface Rig {
  readonly home: string;
  readonly base: string;
  readonly token: string;
  readonly logs: string[];
  readonly loaded: string[];
  readonly cli: (...argv: string[]) => Promise<{ code: number; out: string; err: string }>;
  readonly configText: () => string;
  readonly startRun: () => Promise<void>;
  readonly globalFacts: () => Promise<{ kind: string; payload: unknown; cause: unknown }[]>;
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: {
        demo: { module: demoPath, enabled: true },
        notes: { module: notesPath, enabled: true },
        shell: { module: "@operad-io/shell", enabled: false },
      },
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  const quiet = capture();
  const context = await openContext(home, quiet.io);
  const logs: string[] = [];
  const loaded: string[] = [];
  let server: HttpServerHandle | undefined;
  try {
    server = await startHttpServer({
      home,
      config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
      views: context.views,
      log: context.log,
      registry: context.registry,
      plugins: pluginAdminFor(context, (module, base) => {
        loaded.push(module);
        return loadPlugin(module, base);
      }),
      onLog: (message) => logs.push(message),
    });
    const token = (await readHttpToken(home))?.token ?? "";
    await body({
      home,
      base: server.urls[0] ?? "",
      token,
      logs,
      loaded,
      cli: async (...argv) => {
        const out = capture();
        const code = await main(argv, { home, io: out.io });
        return { code, out: out.out(), err: out.err() };
      },
      configText: () => readFileSync(join(home, "config.json"), "utf8"),
      startRun: async () => {
        const log = openConfigLog(await readConfig(home));
        try {
          await log.startRun("review", "note:n1");
        } finally {
          await log.close();
        }
      },
      globalFacts: async () => {
        const facts: { kind: string; payload: unknown; cause: unknown }[] = [];
        for await (const fact of context.log.readGlobal()) {
          facts.push({ kind: fact.kind, payload: fact.payload, cause: fact.cause });
        }
        return facts;
      },
    });
  } finally {
    await server?.stop();
    context.views.close();
    await context.log.close();
  }
}

function call(rig: Rig, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${rig.base}/v1/plugins`, {
    method,
    headers: { authorization: `Bearer ${rig.token}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Row {
  name: string;
  version: string | null;
  enabled: boolean;
  origin: string;
}

describe("plugins over HTTP", () => {
  test("GET /v1/plugins lists what `operad plugin list` prints, with where each comes from", async () => {
    await withRig(async (rig) => {
      const response = await call(rig, "GET");
      expect(response.status).toBe(200);
      const { plugins } = (await response.json()) as { plugins: Row[] };
      const cli = await rig.cli("plugin", "list");
      expect(cli.code).toBe(0);
      const lines = plugins.map(
        (row) => `${row.name}  ${row.version ?? "-"}  ${row.enabled ? "enabled" : "disabled"}`,
      );
      expect(`${lines.join("\n")}\n`).toBe(cli.out);
      expect(plugins.map((row) => [row.name, row.origin])).toEqual([
        ["demo", "home"],
        ["notes", "home"],
        ["shell", "builtin"],
      ]);
      expect(plugins.find((row) => row.name === "notes")?.version).toBe("0.1.0");
    });
  });

  test("disable and enable change the config the command line reads, and are recorded", async () => {
    await withRig(async (rig) => {
      const off = await call(rig, "POST", { name: "demo", enabled: false, confirmed: true }, { "x-operad-client": "tui" });
      expect(off.status).toBe(200);
      const body = (await off.json()) as { plugin: Row };
      expect(body.plugin).toMatchObject({ name: "demo", enabled: false, origin: "home" });
      expect((await rig.cli("plugin", "list")).out).toContain("demo  -  disabled\n");
      expect(rig.logs.some((line) => line.includes('plugin "demo" disabled via tui as '))).toBe(true);
      const disabled = (await rig.globalFacts()).find(
        (fact) =>
          fact.kind === "plugin_switched" &&
          (fact.payload as { name?: string; enabled?: boolean }).name === "demo" &&
          (fact.payload as { enabled?: boolean }).enabled === false,
      );
      expect(disabled?.payload).toMatchObject({
        name: "demo",
        enabled: false,
        actor: { via: "tui" },
      });
      expect(disabled?.cause).toBe("plugin:demo");

      const on = await call(rig, "POST", { name: "demo", enabled: true });
      expect(on.status).toBe(200);
      expect(((await on.json()) as { plugin: Row }).plugin).toMatchObject({ enabled: true, version: "0.0.1" });
      expect((await rig.cli("plugin", "list")).out).toContain("demo  0.0.1  enabled\n");
      expect(rig.logs.some((line) => line.includes('plugin "demo" enabled via http as '))).toBe(true);
    });
  });

  test("turning a plugin off asks to confirm, and writes nothing without it", async () => {
    await withRig(async (rig) => {
      const before = rig.configText();
      const refused = await call(rig, "POST", { name: "demo", enabled: false });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("confirmed");
      expect(rig.configText()).toBe(before);
    });
  });

  test("a plugin a run is using is refused with the command line's reason", async () => {
    await withRig(async (rig) => {
      await rig.startRun();
      const before = rig.configText();
      const refused = await call(rig, "POST", { name: "notes", enabled: false, confirmed: true });
      expect(refused.status).toBe(409);
      const message = ((await refused.json()) as { error: { message: string } }).error.message;
      expect(message).toMatch(/^cannot disable "notes": run "[^"]+" \(.+\) is active$/);
      const cli = await rig.cli("plugin", "disable", "notes");
      expect(cli.code).toBe(3);
      expect(cli.err).toContain(message);
      expect(rig.configText()).toBe(before);
    });
  });

  test("an unknown plugin is refused with the command line's reason", async () => {
    await withRig(async (rig) => {
      const refused = await call(rig, "POST", { name: "nope", enabled: true });
      expect(refused.status).toBe(404);
      const message = ((await refused.json()) as { error: { message: string } }).error.message;
      expect(message).toBe("plugins.nope: no such plugin");
      expect((await rig.cli("plugin", "enable", "nope")).err).toContain(message);
    });
  });

  test("a body that is not name and enabled is a 400", async () => {
    await withRig(async (rig) => {
      expect((await call(rig, "POST", { name: "demo" })).status).toBe(400);
      expect((await call(rig, "POST", { enabled: true })).status).toBe(400);
      expect((await call(rig, "PUT", {})).status).toBe(405);
    });
  });

  test("the bearer token is required to list and to switch", async () => {
    await withRig(async (rig) => {
      const before = rig.configText();
      for (const authorization of [undefined, "Bearer wrong"]) {
        const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
        const list = await fetch(`${rig.base}/v1/plugins`, { headers });
        expect(list.status).toBe(401);
        const set = await fetch(`${rig.base}/v1/plugins`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "demo", enabled: false, confirmed: true }),
        });
        expect(set.status).toBe(401);
      }
      expect(rig.configText()).toBe(before);
    });
  });

  test("a plugin filed under another key than its declared name is switched by either name", async () => {
    await withRig(async (rig) => {
      const file = join(rig.home, "keyed.ts");
      writeFileSync(
        file,
        `import { definePlugin } from ${JSON.stringify(join(import.meta.dir, "../../engine/src/index.ts"))};
export default definePlugin({ name: "declared", kind: "domain", version: "2.0.0", objects: [{ name: "thing" }] });
`,
      );
      const raw = JSON.parse(rig.configText()) as { plugins: Record<string, unknown> };
      raw.plugins.keyed = { module: file, enabled: false };
      writeFileSync(join(rig.home, "config.json"), JSON.stringify(raw));
      const byKey = await call(rig, "POST", { name: "keyed", enabled: true });
      expect(byKey.status).toBe(200);
      expect(((await byKey.json()) as { plugin: Row }).plugin).toMatchObject({ name: "declared", enabled: true });
      const byName = await call(rig, "POST", { name: "declared", enabled: false, confirmed: true });
      expect(byName.status).toBe(200);
      expect((JSON.parse(rig.configText()) as { plugins: { keyed: { enabled: boolean } } }).plugins.keyed.enabled).toBe(false);
    });
  });

  test("listing again does not load a plugin file again", async () => {
    await withRig(async (rig) => {
      await call(rig, "GET");
      const first = rig.loaded.length;
      expect(first).toBe(2);
      await call(rig, "GET");
      await call(rig, "GET");
      expect(rig.loaded.length).toBe(first);
    });
  });

  test("a plugin file that fails to load is not imported on every list", async () => {
    await withRig(async (rig) => {
      const broken = join(rig.home, "broken.ts");
      writeFileSync(broken, "this is not a plugin\n");
      const raw = JSON.parse(rig.configText()) as { plugins: Record<string, unknown> };
      raw.plugins.broken = { module: broken, enabled: true };
      writeFileSync(join(rig.home, "config.json"), JSON.stringify(raw));
      expect((await call(rig, "GET")).status).toBe(200);
      expect((await call(rig, "GET")).status).toBe(200);
      expect(rig.loaded.filter((module) => module === broken)).toHaveLength(1);
    });
  });
});
