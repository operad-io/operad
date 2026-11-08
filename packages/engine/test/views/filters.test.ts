import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createViews,
  MemoryPluginStore,
  openConfigLog,
  PluginError,
  PluginRegistry,
  readConfig,
  readHttpToken,
  startHttpServer,
  typeFilters,
  ViewError,
  type ObjectFilterDefinition,
  type HttpServerHandle,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";
import { mkdirSync, writeFileSync } from "node:fs";

afterAll(cleanupTempRoots);

const FILTERS: readonly ObjectFilterDefinition[] = [
  { name: "active", states: ["new", "open"], default: true },
  { name: "done", states: ["merged"] },
  { name: "cancelled", states: ["cancelled"] },
];

function plugin(filters?: readonly ObjectFilterDefinition[]) {
  const views = {
    row(object: { id: string; data: Record<string, unknown> }) {
      if (object.data.broken === true) throw new Error("row failed");
      return {
        id: object.id,
        title: String(object.data.title ?? object.id),
        state: String(object.data.state ?? "new"),
      };
    },
    sections: () => [],
    load: () => ({ markdown: "" }),
  };
  return def({
    name: "jobs",
    objects: [
      { name: "job", ...(filters === undefined ? {} : { filters }) },
      { name: "plain" },
    ],
    views: { job: views, plain: views },
  });
}

const opened: ReturnType<typeof createViews>[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

function setup(filters: readonly ObjectFilterDefinition[] | undefined = FILTERS) {
  const store = new MemoryPluginStore({ root: "unused" });
  const registry = new PluginRegistry([plugin(filters)], { store });
  const views = createViews({ registry, store, onLog: () => undefined });
  opened.push(views);
  return { store, registry, views };
}

function seed(
  store: MemoryPluginStore,
  type: string,
  rows: Record<string, Record<string, unknown>>,
): void {
  for (const [id, data] of Object.entries(rows)) store.put(type, id, data, "seed");
}

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PluginError) return error.message;
    throw error;
  }
  throw new Error("expected a PluginError");
}

describe("object type filters", () => {
  test("the kernel puts all right after the default", () => {
    expect(typeFilters({ name: "job", filters: FILTERS })).toEqual({
      default: "active",
      filters: [
        { name: "active", states: ["new", "open"] },
        { name: "all" },
        { name: "done", states: ["merged"] },
        { name: "cancelled", states: ["cancelled"] },
      ],
    });
    expect(typeFilters({ name: "plain" })).toBeUndefined();
    const first = typeFilters({
      name: "job",
      filters: [{ name: "b", states: ["x"] }, { name: "a", states: ["y"], default: true }],
    });
    expect(first?.filters.map((filter) => filter.name)).toEqual(["b", "a", "all"]);
    // With none marked, the first filter is the default.
    expect(
      typeFilters({ name: "job", filters: [{ name: "b", states: ["x"] }] })?.default,
    ).toBe("b");
  });

  test("plugin loading refuses a malformed declaration with the field path", () => {
    const build = (filters: unknown) =>
      message(
        () =>
          new PluginRegistry([
            def({
              name: "bad",
              objects: [{ name: "job", filters: filters as never }],
            }),
          ]),
      );
    expect(build([{ name: "", states: ["a"] }])).toContain("objects[0]: filters[0]: name");
    expect(
      build([
        { name: "a", states: ["x"] },
        { name: "a", states: ["y"] },
      ]),
    ).toContain('filters[1]: name: duplicate filter "a"');
    expect(
      build([
        { name: "a", states: ["x"], default: true },
        { name: "b", states: ["y"], default: true },
      ]),
    ).toContain("filters[1]: default");
    expect(build([{ name: "a", states: [] }])).toContain("filters[0]: states");
    expect(build([{ name: "all", states: ["x"] }])).toContain("filters[0]: name");
    expect(build("nope")).toContain("filters: must be an array");
  });

  test("a filter keeps matching rows and counts the rest as hidden", async () => {
    const { store, views } = setup();
    seed(store, "job", {
      a: { state: "new" },
      b: { state: "merged" },
      c: { state: "open" },
      d: { state: "cancelled" },
    });
    const active = await views.list("job", { filter: "active" });
    expect(active.rows.map((row) => row.id)).toEqual(["a", "c"]);
    expect(active.hidden).toBe(2);
    const done = await views.list("job", { filter: "done" });
    expect(done.rows.map((row) => row.id)).toEqual(["b"]);
    expect(done.hidden).toBe(3);
    const all = await views.list("job", { filter: "all" });
    expect(all.rows.length).toBe(4);
    expect(all.hidden).toBeUndefined();
    expect(views.defaultFilterOf("job")).toBe("active");
    expect(views.defaultFilterOf("plain")).toBeUndefined();
    // Without a filter the views list everything, as before.
    expect((await views.list("job")).rows.length).toBe(4);
  });

  test("a filter that hides every row returns no rows and the total", async () => {
    const { store, views } = setup();
    seed(store, "job", { a: { state: "merged" }, b: { state: "merged" } });
    const page = await views.list("job", { filter: "cancelled" });
    expect(page.rows).toEqual([]);
    expect(page.hidden).toBe(2);
  });

  test("an error row is shown by every filter", async () => {
    const { store, views } = setup();
    seed(store, "job", { a: { state: "merged" }, bad: { broken: true } });
    for (const filter of ["active", "done", "cancelled"]) {
      const page = await views.list("job", { filter });
      expect(page.rows.some((row) => row.state === "error")).toBe(true);
    }
    expect((await views.list("job", { filter: "done" })).hidden).toBe(0);
  });

  test("an unknown filter names the allowed ones; a type without filters refuses", async () => {
    const { views } = setup();
    const unknown = await views.list("job", { filter: "nope" }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ViewError);
    expect((unknown as ViewError).kind).toBe("filter");
    expect((unknown as ViewError).message).toContain("allowed: active, all, done, cancelled");
    const none = await views.list("plain", { filter: "x" }).catch((e: unknown) => e);
    expect((none as ViewError).message).toContain("this type has no filters");
  });

  test("paging works within the filtered list and never returns a short page early", async () => {
    const { store, views } = setup();
    const rows: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 9; index += 1) {
      const id = `r${index}`;
      // Two merged rows sit between every pair of active rows.
      rows[id] = { state: index % 3 === 0 ? "new" : "merged" };
    }
    seed(store, "job", rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await views.list("job", {
        filter: "active",
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((row) => row.id));
      expect(page.hidden).toBe(6);
      cursor = page.next;
    } while (cursor !== undefined);
    expect(seen).toEqual(["r0", "r3", "r6"]);
    expect(sizes).toEqual([2, 1]);

    const first = await views.list("job", { filter: "active", limit: 1 });
    const other = await views
      .list("job", { filter: "done", limit: 1, cursor: first.next ?? "" })
      .catch((e: unknown) => e);
    expect((other as ViewError).kind).toBe("cursor");
  });
});

describe("filters over HTTP", () => {
  let server: HttpServerHandle | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("/v1/types lists filters and /v1/objects applies them", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ store: { backend: "jsonl", path: join(root, "store") } }),
    );
    const log = openConfigLog(await readConfig(home));
    const { store, registry, views } = setup();
    seed(store, "job", {
      a: { state: "new" },
      b: { state: "merged" },
      c: { state: "open" },
    });
    seed(store, "plain", { p: { state: "merged" } });
    server = await startHttpServer({
      home,
      config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
      views,
      log,
      registry,
      onLog: () => undefined,
    });
    const token = (await readHttpToken(home))?.token ?? "";
    const base = server.urls[0] ?? "";
    const get = async (path: string) => {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const types = await get("/v1/types");
    expect(types.body.types).toEqual([
      {
        type: "job",
        title: "Job",
        plugin: "jobs",
        filters: [
          { name: "active", states: ["new", "open"] },
          { name: "all" },
          { name: "done", states: ["merged"] },
          { name: "cancelled", states: ["cancelled"] },
        ],
        defaultFilter: "active",
      },
      { type: "plain", title: "Plain", plugin: "jobs" },
    ]);

    const byDefault = await get("/v1/objects?type=job");
    expect((byDefault.body.rows as { id: string }[]).map((row) => row.id)).toEqual(["a", "c"]);
    expect(byDefault.body.hidden).toBe(1);
    const done = await get("/v1/objects?type=job&filter=done");
    expect((done.body.rows as { id: string }[]).map((row) => row.id)).toEqual(["b"]);
    expect(done.body.hidden).toBe(2);
    const all = await get("/v1/objects?type=job&filter=all");
    expect((all.body.rows as unknown[]).length).toBe(3);
    expect(all.body.hidden).toBeUndefined();
    const bad = await get("/v1/objects?type=job&filter=zzz");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("allowed: active, all, done, cancelled");
    const plain = await get("/v1/objects?type=plain");
    expect(plain.body).not.toHaveProperty("hidden");
    expect((await get("/v1/objects?type=plain&filter=x")).status).toBe(400);
  });
});
