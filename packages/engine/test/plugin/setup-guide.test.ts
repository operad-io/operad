import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  guideBody,
  loadPluginRegistry,
  parseOptionalPlugins,
  PluginRegistry,
  shareOptionalPlugins,
  sharedOptionalPlugins,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const GUIDE = fileURLToPath(new URL("../fixtures/plugins/guided/SKILL.md", import.meta.url));
const GUIDED = fileURLToPath(new URL("../fixtures/plugins/guided.ts", import.meta.url));

const MISSING = [
  { name: "token", description: "no token is stored" },
  { name: "user", description: "no user is listed" },
];

describe("a check that reports what is missing (ADR 0010 D7)", () => {
  test("the object form carries the items, and the note is the line init prints", async () => {
    const registry = new PluginRegistry([def({ name: "a", check: () => ({ note: "not set up", missing: MISSING }) })]);
    expect(await registry.checks()).toEqual([{ plugin: "a", ok: true, message: "not set up", missing: MISSING }]);
  });

  test("without a note the line is the descriptions joined", async () => {
    const registry = new PluginRegistry([def({ name: "a", check: () => ({ missing: MISSING }) })]);
    expect((await registry.checks())[0]?.message).toBe("no token is stored; no user is listed");
  });

  test("an empty list is ok, and the one-line and no-value forms are unchanged", async () => {
    const registry = new PluginRegistry([
      def({ name: "a", check: () => ({ missing: [] }) }),
      def({ name: "b", check: () => "2 checked" }),
      def({ name: "c", check: () => undefined }),
    ]);
    expect(await registry.checks()).toEqual([
      { plugin: "a", ok: true, message: "ok", missing: [] },
      { plugin: "b", ok: true, message: "2 checked" },
      { plugin: "c", ok: true, message: "ok" },
    ]);
  });

  test("a malformed or repeated item is a failed check", async () => {
    const registry = new PluginRegistry([
      def({ name: "a", check: () => ({ missing: [{ name: "x", description: "" }] }) }),
      def({
        name: "b",
        check: () => ({ missing: [{ name: "x", description: "one" }, { name: "x", description: "two" }] }),
      }),
    ]);
    const [a, b] = await registry.checks();
    expect(a?.ok).toBe(false);
    expect(a?.message).toContain("needs a name and a description");
    expect(b?.ok).toBe(false);
    expect(b?.message).toContain('"x" is listed twice');
  });

  test("a guide must be an absolute path", () => {
    expect(() => new PluginRegistry([def({ name: "a", guide: "SKILL.md" })])).toThrow("absolute path");
  });
});

describe("the setup reader", () => {
  test("a loaded plugin's guide comes without its front matter, with what its check reports", async () => {
    const registry = new PluginRegistry([def({ name: "a", guide: GUIDE, check: () => ({ missing: MISSING }) })]);
    const guide = await registry.setupReader().get("a");
    expect(guide?.enabled).toBe(true);
    expect(guide?.missing).toEqual(MISSING);
    expect(guide?.text.startsWith("Ask the person for the token")).toBe(true);
    expect(guide?.text).not.toContain("description:");
  });

  test("a plugin with no guide, and an unknown name, have none; list names those that have one", async () => {
    const registry = new PluginRegistry([def({ name: "a", guide: GUIDE }), def({ name: "b" })]);
    const reader = registry.setupReader();
    expect(await reader.get("b")).toBeUndefined();
    expect(await reader.get("nope")).toBeUndefined();
    expect(await reader.list()).toEqual([{ plugin: "a", enabled: true }]);
  });

  test("a check that throws is one missing item, not a refusal to set up", async () => {
    const registry = new PluginRegistry([
      def({
        name: "a",
        guide: GUIDE,
        check: () => {
          throw new Error("cannot reach");
        },
      }),
    ]);
    expect((await registry.setupReader().get("a"))?.missing).toEqual([
      { name: "check", description: "the check failed: cannot reach" },
    ]);
  });

  test("an off plugin's guide is read from its module and reports the one item enable", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ plugins: { guided: { module: GUIDED, enabled: false } } }),
    );
    const registry = await loadPluginRegistry({ home, onLog: () => undefined });
    expect(registry.names()).toEqual([]);
    const reader = registry.setupReader();
    expect(await reader.list()).toEqual([{ plugin: "guided", enabled: false }]);
    const guide = await reader.get("guided");
    expect(guide?.enabled).toBe(false);
    expect(guide?.missing).toEqual([{ name: "enable", description: 'the plugin "guided" is off' }]);
    expect(guide?.text).toContain("Ask the person for the token");
  });

  test("an off plugin whose module has no guide, or is not in the config, has none", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const bare = join(home, "bare.ts");
    writeFileSync(bare, 'export default { name: "bare", kind: "domain", version: "0.0.1" };\n');
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { bare: { module: bare, enabled: false } } }));
    const reader = (await loadPluginRegistry({ home, onLog: () => undefined })).setupReader();
    expect(await reader.list()).toEqual([]);
    expect(await reader.get("bare")).toBeUndefined();
    expect(await reader.get("ghost")).toBeUndefined();
  });

  test("an offered plugin that config.json does not name yet has its guide readable; a named one that is on does not", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: {} }));
    const registry = await loadPluginRegistry({
      home,
      optional: { guided: GUIDED },
      onLog: () => undefined,
    });
    const reader = registry.setupReader();
    expect(await reader.list()).toEqual([{ plugin: "guided", enabled: false }]);
    expect((await reader.get("guided"))?.missing.map((item) => item.name)).toEqual(["enable"]);
    // Neither configured nor offered: still no guide.
    expect(await reader.get("ghost")).toBeUndefined();
  });

  test("the offered list a process shares is the one it reads back; other text is none", () => {
    const env: Record<string, string | undefined> = {};
    expect(sharedOptionalPlugins(env)).toBeUndefined();
    shareOptionalPlugins({ guided: GUIDED }, env);
    expect(sharedOptionalPlugins(env)).toEqual({ guided: GUIDED });
    expect(parseOptionalPlugins("not json")).toBeUndefined();
    expect(parseOptionalPlugins('["a"]')).toBeUndefined();
    expect(parseOptionalPlugins('{"a":1,"b":"c"}')).toEqual({ b: "c" });
  });

  test("a command and an action are given the reader", async () => {
    let fromCommand: unknown;
    let fromAction: unknown;
    const registry = new PluginRegistry([
      def({
        name: "a",
        guide: GUIDE,
        objects: [{ name: "thing" }],
        commands: [
          {
            name: "peek",
            args: "",
            async run(ctx) {
              fromCommand = (await ctx.setup?.list())?.map((item) => item.plugin);
              return "ok";
            },
          },
        ],
        actions: [
          {
            name: "peek",
            on: "thing",
            when: () => true,
            async run(ctx) {
              fromAction = (await ctx.setup?.list())?.map((item) => item.plugin);
              return "ok";
            },
          },
        ],
      }),
    ]);
    await registry.runCommand(["a", "peek"], { cwd: "/" });
    await registry.runAction("a/peek", {}, {
      object: { type: "thing", id: "1", data: {} },
      actor: { via: "cli", id: "me" },
    });
    expect(fromCommand).toEqual(["a"]);
    expect(fromAction).toEqual(["a"]);
  });
});

describe("guideBody", () => {
  test("drops the front matter and keeps text that has none", () => {
    expect(guideBody("---\nname: x\n---\n\nbody\n")).toBe("body");
    expect(guideBody("just text\n")).toBe("just text");
  });
});
