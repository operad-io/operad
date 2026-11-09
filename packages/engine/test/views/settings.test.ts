import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  MemoryPluginStore,
  PluginRegistry,
  ViewError,
  type Views,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const CHILD = join(import.meta.dir, "..", "fixtures", "atomic-write-child.ts");

interface Setup {
  readonly home: string;
  readonly repo: string;
  readonly views: Views;
  readonly config: () => string;
}

async function setup(configText?: string): Promise<Setup> {
  const root = await tempRoot();
  const home = join(root, "home");
  const repo = join(root, "alpha");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".operad"), { recursive: true });
  const file = join(home, "config.json");
  writeFileSync(
    file,
    configText ??
      `${JSON.stringify(
        { store: { backend: "jsonl" }, plugins: { demo: { module: "demo", settings: { limit: 3 } } }, http: { port: 1 } },
        null,
        2,
      )}\n`,
  );
  const settings = JSON.parse(readFileSync(file, "utf8")).plugins?.demo?.settings ?? {};
  const store = new MemoryPluginStore({ root });
  const registry = new PluginRegistry(
    [
      def({
        name: "demo",
        settings: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              default: 2,
              description: "How many at once.",
              editable: true,
            },
            mode: { type: "string", enum: ["a", "b"], default: "a", editable: true, confirm: true },
            fixed: { type: "string", default: "x" },
            nested: {
              type: "object",
              properties: { depth: { type: "integer", editable: true } },
            },
          },
        },
        projectSettings: {
          repositories: () => [{ name: "alpha", path: repo }],
          files: [
            {
              name: "review",
              path: "review.json",
              schema: {
                type: "object",
                properties: {
                  level: { type: "string", enum: ["low", "high"], default: "low", editable: true },
                },
              },
            },
          ],
        },
      }),
    ],
    { home, store, settings: { demo: settings } },
  );
  const views = createViews({ registry, store });
  return { home, repo, views, config: () => readFileSync(file, "utf8") };
}

describe("settings", () => {
  test("lists every setting with value, default, description and marks", async () => {
    const { views } = await setup();
    const all = await views.settings();
    const limit = all.find((item) => item.name === "demo.limit");
    expect(limit).toEqual({
      name: "demo.limit",
      scope: "global",
      value: 3,
      default: 2,
      description: "How many at once.",
      editable: true,
      confirm: false,
    });
    const mode = all.find((item) => item.name === "demo.mode");
    expect(mode?.value).toBe("a");
    expect(mode?.confirm).toBe(true);
    expect(all.find((item) => item.name === "demo.fixed")?.editable).toBe(false);
    expect(all.find((item) => item.name === "demo.nested.depth")?.value).toBeUndefined();
    expect(all.find((item) => item.name === "demo.review.level")).toEqual({
      name: "demo.review.level",
      scope: "alpha",
      value: "low",
      default: "low",
      editable: true,
      confirm: false,
    });
    expect((await views.settings("global")).every((item) => item.scope === "global")).toBe(true);
  });

  test("a valid value is written and read back", async () => {
    const { views, config } = await setup();
    const result = await views.set("demo.limit", 7);
    expect(result.value).toBe(7);
    expect(JSON.parse(config()).plugins.demo.settings.limit).toBe(7);
    const listed = (await views.settings("global")).find((item) => item.name === "demo.limit");
    expect(listed?.value).toBe(7);
  });

  test("an invalid value is refused with the schema's reason and nothing is written", async () => {
    const { views, config } = await setup();
    const before = config();
    const error = await views.set("demo.limit", 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect((error as ViewError).kind).toBe("args");
    expect((error as ViewError).message).toContain("must be at least 1");
    const wrongType = await views.set("demo.limit", "many").catch((e: unknown) => e);
    expect((wrongType as ViewError).message).toContain("must be a integer");
    expect(config()).toBe(before);
  });

  test("a setting that is not editable, or unknown, is refused", async () => {
    const { views, config } = await setup();
    const before = config();
    const fixed = await views.set("demo.fixed", "y").catch((e: unknown) => e);
    expect((fixed as ViewError).kind).toBe("not-available");
    const unknown = await views.set("demo.nope", 1).catch((e: unknown) => e);
    expect((unknown as ViewError).kind).toBe("not-found");
    expect(config()).toBe(before);
  });

  test("a confirm setting needs confirmed", async () => {
    const { views, config } = await setup();
    const before = config();
    const refused = await views.set("demo.mode", "b").catch((e: unknown) => e);
    expect((refused as ViewError).kind).toBe("confirm");
    expect(config()).toBe(before);
    await views.set("demo.mode", "b", { confirmed: true });
    expect(JSON.parse(config()).plugins.demo.settings.mode).toBe("b");
  });

  test("the rest of the file keeps its keys, order and indent", async () => {
    const text = '{\n\t"store": { "backend": "jsonl" },\n\t"plugins": {\n\t\t"demo": { "module": "demo", "settings": { "limit": 3, "mode": "a" } }\n\t},\n\t"http": { "port": 1 }\n}';
    const { views, config } = await setup(text);
    await views.set("demo.nested.depth", 4);
    const after = config();
    expect(after.startsWith('{\n\t"store"')).toBe(true);
    expect(after.endsWith("}")).toBe(true);
    const parsed = JSON.parse(after);
    expect(Object.keys(parsed)).toEqual(["store", "plugins", "http"]);
    expect(Object.keys(parsed.plugins.demo.settings)).toEqual(["limit", "mode", "nested"]);
    expect(parsed.plugins.demo.settings.nested).toEqual({ depth: 4 });
    expect(parsed.http).toEqual({ port: 1 });
  });

  test("project scope names the repository and writes its own file", async () => {
    const { views, repo, config } = await setup();
    const before = config();
    await views.set("demo.review.level", "high", { scope: "alpha" });
    const file = join(repo, ".operad", "review.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ level: "high" });
    expect(config()).toBe(before);
    expect((await views.settings("alpha")).map((item) => item.name)).toEqual(["demo.review.level"]);
    const bad = await views.set("demo.review.level", "mid", { scope: "alpha" }).catch((e: unknown) => e);
    expect((bad as ViewError).kind).toBe("args");
    const none = await views.settings("beta").catch((e: unknown) => e);
    expect((none as ViewError).kind).toBe("not-found");
    expect((none as ViewError).message).toContain("alpha");
    // the global name does not exist in the repository's scope
    const wrong = await views.set("demo.limit", 5, { scope: "alpha" }).catch((e: unknown) => e);
    expect((wrong as ViewError).kind).toBe("not-found");
  });

  test("a writer killed before the rename leaves the old file whole", async () => {
    const { home, config } = await setup();
    const target = join(home, "config.json");
    const before = config();
    const child = Bun.spawn([process.execPath, CHILD, target, '{"partial":'], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    if (!new TextDecoder().decode(first.value).includes("ready")) {
      throw new Error(`child never reached the rename: ${await new Response(child.stderr).text()}`);
    }
    child.kill("SIGKILL");
    await child.exited;
    expect(config()).toBe(before);
    expect(() => JSON.parse(config())).not.toThrow();
  });
});

describe("settings declarations", () => {
  test("editable and confirm must be booleans", () => {
    const make = (property: Record<string, unknown>): PluginRegistry =>
      new PluginRegistry(
        [def({ name: "bad", settings: { type: "object", properties: { x: { type: "string", ...property } } } })],
        { home: "/nonexistent", store: new MemoryPluginStore({ root: "/nonexistent" }) },
      );
    expect(() => make({ editable: "yes" })).toThrow("editable: must be a boolean");
    expect(() => make({ confirm: 1 })).toThrow("confirm: must be a boolean");
    expect(() => make({ editable: true, confirm: true })).not.toThrow();
  });

  test("a project settings file path stays under .operad", () => {
    const make = (path: string): PluginRegistry =>
      new PluginRegistry(
        [
          def({
            name: "bad",
            projectSettings: {
              repositories: () => [],
              files: [{ name: "f", path, schema: { type: "object" } }],
            },
          }),
        ],
        { home: "/nonexistent", store: new MemoryPluginStore({ root: "/nonexistent" }) },
      );
    expect(() => make("../x.json")).toThrow("path");
    expect(() => make("/etc/x.json")).toThrow("path");
    expect(() => make("a/b.json")).not.toThrow();
  });
});
