import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { testEnv } from "../env.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPluginStore, readHttpToken } from "@operad-io/engine";
import { main, type CliIo } from "../../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  delete process.env.OPERAD_TEST_REPOS;
});

const CLI_ENTRY = fileURLToPath(new URL("../../bin/operad.ts", import.meta.url));
const settingsPlugin = fileURLToPath(new URL("../fixtures/settings-plugin.ts", import.meta.url));
const httpPlugin = fileURLToPath(
  new URL("../../../engine/test/fixtures/plugins/http.ts", import.meta.url),
);

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function operad(home: string, ...args: string[]): Promise<Run> {
  let out = "";
  let err = "";
  const io: CliIo = {
    write: (text) => {
      out += text;
    },
    error: (text) => {
      err += text;
    },
    readLine: async () => undefined,
  };
  const code = await main(args, { home, io, isTTY: false });
  return { code, out, err };
}

async function makeHome(plugin = settingsPlugin, extra: Record<string, unknown> = {}) {
  const root = await tempRoot();
  const home = join(root, "home");
  const repo = join(root, "alpha");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const config = join(home, "config.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        plugins: { demo: { module: plugin, settings: { limit: 3 } } },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        notes: ["keep", "me"],
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
  process.env.OPERAD_TEST_REPOS = JSON.stringify([{ name: "alpha", path: repo }]);
  return { root, home, repo, config };
}

describe("operad settings", () => {
  test("lists every setting, as text and as JSON", async () => {
    const { home } = await makeHome();
    const text = await operad(home, "settings");
    expect(text.code).toBe(0);
    expect(text.out).toContain("global  demo.limit  3  default 2  editable  Items at once.");
    expect(text.out).toContain("global  demo.mode  \"a\"  default \"a\"  editable,confirm");
    expect(text.out).toContain("global  demo.fixed  \"x\"  default \"x\"  read-only");
    expect(text.out).toContain("alpha  demo.review.level  \"low\"");

    const json = await operad(home, "settings", "--json", "--repo", "alpha");
    const parsed = JSON.parse(json.out) as { name: string; scope: string }[];
    expect(parsed.map((item) => item.name)).toEqual(["demo.review.level"]);
    expect(parsed[0]?.scope).toBe("alpha");

    const missing = await operad(home, "settings", "--repo", "beta");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no registered repository "beta"');
  });

  test("set parses JSON, falls back to a string, and keeps the rest of the file", async () => {
    const { home, config } = await makeHome();
    const number = await operad(home, "settings", "set", "demo.limit", "9");
    expect(number.code).toBe(0);
    expect(number.out).toBe("demo.limit = 9\n");
    const text = await operad(home, "settings", "set", "demo.label", "hello world");
    expect(text.code).toBe(0);
    const file = JSON.parse(readFileSync(config, "utf8"));
    expect(file.plugins.demo.settings).toEqual({ limit: 9, label: "hello world" });
    expect(file.notes).toEqual(["keep", "me"]);
    expect(Object.keys(file)).toEqual(["plugins", "store", "notes"]);
  });

  test("set refuses an invalid value, a read-only setting and a missing confirmation", async () => {
    const { home, config } = await makeHome();
    const before = readFileSync(config, "utf8");
    const invalid = await operad(home, "settings", "set", "demo.limit", "0");
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain("must be at least 1");
    const readOnly = await operad(home, "settings", "set", "demo.fixed", "y");
    expect(readOnly.code).toBe(3);
    const unconfirmed = await operad(home, "settings", "set", "demo.mode", "b");
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("--yes");
    expect(readFileSync(config, "utf8")).toBe(before);

    const confirmed = await operad(home, "settings", "set", "demo.mode", "b", "--yes");
    expect(confirmed.code).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8")).plugins.demo.settings.mode).toBe("b");
    expect((await operad(home, "settings", "set", "demo.limit")).code).toBe(2);
  });

  test("--repo changes the file under that repository's .operad", async () => {
    const { home, repo, config } = await makeHome();
    const before = readFileSync(config, "utf8");
    const result = await operad(home, "settings", "set", "demo.review.level", "high", "--repo", "alpha");
    expect(result.code).toBe(0);
    expect(result.out).toBe("demo.review.level = \"high\" (alpha)\n");
    expect(JSON.parse(readFileSync(join(repo, ".operad", "review.json"), "utf8"))).toEqual({
      level: "high",
    });
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  test("a running serve answers GET and POST /v1/settings and sees what the CLI wrote", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port;
    await probe.stop(true);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { webtest: { module: httpPlugin } },
        store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
        http: { enabled: true, port, listen: ["127.0.0.1"] },
      }),
    );
    const store = openPluginStore({ backend: "sqlite", root: join(root, "store") });
    await store.put("item", "one", { title: "One", state: "new" }, "seed");
    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "serve"],
      cwd: home,
      env: { ...testEnv(), OPERAD_HOME: home, OPERAD_RELOAD_QUIET_MS: "50", OPERAD_RELOAD_POLL_MS: "200" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let seen = "";
      const until = async (pattern: RegExp): Promise<void> => {
        while (!pattern.test(seen)) {
          const read = await reader.read();
          if (read.done) throw new Error(`serve ended: ${seen}`);
          seen += new TextDecoder().decode(read.value);
        }
      };
      const listening = new RegExp(`http http://127.0.0.1:${port}`);
      await until(listening);
      const token = await readHttpToken(home);
      if (token === undefined) throw new Error("no token");
      const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
      const base = `http://127.0.0.1:${port}/v1/settings`;
      const post = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "webtest.limit", value: 6 }),
      });
      expect(post.status).toBe(200);
      const listed = (await (await fetch(`${base}?scope=global`, { headers })).json()) as {
        settings: { name: string; value: number }[];
      };
      expect(listed.settings.find((item) => item.name === "webtest.limit")?.value).toBe(6);
      // The serve takes the new value up: it reloads, and the plugin's action
      // then sees 6, not the default 2.
      await until(/reloading: settings[\s\S]*http http/);
      const acted = await fetch(`http://127.0.0.1:${port}/v1/act`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "webtest:limit", id: "one" }),
      });
      expect(acted.status).toBe(200);
      expect(((await acted.json()) as { value: unknown }).value).toBe(6);
      const shown = await operad(home, "settings");
      expect(shown.out).toContain("global  webtest.limit  6  default 2");
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  });
});
