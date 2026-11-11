import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  MemoryPluginStore,
  openConfigLog,
  PluginRegistry,
  readConfig,
  readHttpToken,
  startHttpServer,
  ViewError,
  type HttpServerHandle,
} from "../../src/index.ts";
import tree from "../fixtures/plugins/tree.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const opened: ReturnType<typeof createViews>[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

function setup() {
  const store = new MemoryPluginStore({ root: "unused" });
  const registry = new PluginRegistry([tree], { store });
  const views = createViews({ registry, store, onLog: () => undefined });
  opened.push(views);
  store.put("group", "g1", { title: "G1" }, "seed");
  store.put("group", "g2", { title: "G2" }, "seed");
  store.put("leaf", "a", { state: "open", parent: "group:g1" }, "seed");
  store.put("leaf", "b", { state: "merged", parent: "group:g1" }, "seed");
  store.put("leaf", "c", { state: "open", parent: "group:g2" }, "seed");
  store.put("leaf", "d", { state: "open" }, "seed");
  store.put("leaf", "e", { state: "open", parent: "group:gone" }, "seed");
  return { store, registry, views };
}

const ids = (page: { rows: readonly { id: string }[] }) => page.rows.map((row) => row.id);

describe("row parent", () => {
  test("root lists only rows with no parent, across types in type order", async () => {
    const { views } = setup();
    expect(ids(await views.list("group", { root: true }))).toEqual(["g1", "g2"]);
    expect(ids(await views.listTree(undefined, { root: true }))).toEqual(["g1", "g2", "d"]);
  });

  test("parent= lists only that parent's children and the row carries parent", async () => {
    const { views } = setup();
    const page = await views.list("leaf", { parent: "group:g1", filter: "all" });
    expect(ids(page)).toEqual(["a", "b"]);
    expect(page.rows[0]?.parent).toBe("group:g1");
    expect(ids(await views.listTree(undefined, { parent: "group:g2" }))).toEqual(["c"]);
    // A bare id resolves the way get does.
    expect(ids(await views.listTree(undefined, { parent: "g2" }))).toEqual(["c"]);
  });

  test("the default filter applies under parent= and hidden counts the filtered rows", async () => {
    const { views } = setup();
    const page = await views.list("leaf", { parent: "group:g1" });
    expect(ids(page)).toEqual(["a"]);
    expect(page.hidden).toBe(1);
    expect(page.hiddenCounts).toEqual({ done: 1, cancelled: 0, other: 0 });
    const done = await views.list("leaf", { parent: "group:g1", filter: "done" });
    expect(ids(done)).toEqual(["b"]);
    expect(done.hidden).toBe(1);
    expect(done.hiddenCounts).toEqual({ done: 0, cancelled: 0, other: 1 });
    const root = await views.list("leaf", { root: true });
    expect(ids(root)).toEqual(["d"]);
    expect(root.hidden).toBe(0);
    await expect(views.list("leaf", { parent: "group:g1", filter: "x" })).rejects.toBeInstanceOf(
      ViewError,
    );
  });

  test("an unknown parent lists nothing, and a dangling parent is not root", async () => {
    const { views } = setup();
    expect(ids(await views.listTree(undefined, { parent: "group:nothing" }))).toEqual([]);
    expect(ids(await views.listTree(undefined, { parent: "group:gone" }))).toEqual(["e"]);
    expect(ids(await views.listTree(undefined, { root: true }))).not.toContain("e");
  });

  test("pages keep the order and a cursor cannot be moved to another list", async () => {
    const { views } = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await views.listTree(undefined, {
        root: true,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...ids(page));
      cursor = page.next;
    } while (cursor !== undefined);
    expect(seen).toEqual(["g1", "g2", "d"]);
    const first = await views.listTree(undefined, { root: true, limit: 1 });
    const moved = await views
      .listTree(undefined, { parent: "group:g1", cursor: first.next ?? "" })
      .catch((error: unknown) => error);
    expect((moved as ViewError).kind).toBe("cursor");
    const level = await views.listTree(undefined, {
      parent: "group:g1",
      filter: "all",
      limit: 1,
    });
    const sibling = await views
      .listTree(undefined, { parent: "group:g2", filter: "all", cursor: level.next ?? "" })
      .catch((error: unknown) => error);
    expect((sibling as ViewError).kind).toBe("cursor");
  });

  test("root and parent together are refused", async () => {
    const { views } = setup();
    const refused = await views
      .listTree(undefined, { root: true, parent: "group:g1" })
      .catch((error: unknown) => error);
    expect((refused as ViewError).kind).toBe("args");
  });
});

describe("hierarchy over HTTP", () => {
  let server: HttpServerHandle | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("/v1/types names the plugin and /v1/objects takes root and parent", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ store: { backend: "jsonl", path: join(root, "store") } }),
    );
    const log = openConfigLog(await readConfig(home));
    const { store, registry, views } = setup();
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
    const types = (await get("/v1/types")).body.types as { type: string; plugin: string }[];
    expect(types.map((entry) => [entry.type, entry.plugin])).toEqual([
      ["group", "tree"],
      ["leaf", "tree"],
    ]);

    const rootRows = (await get("/v1/objects?root")).body.rows as { id: string }[];
    expect(rootRows.map((row) => row.id)).toEqual(["g1", "g2", "d"]);
    const rootLeaf = await get("/v1/objects?type=leaf&root");
    expect((rootLeaf.body.rows as { id: string }[]).map((row) => row.id)).toEqual(["d"]);
    const children = await get(`/v1/objects?parent=${encodeURIComponent("group:g1")}`);
    expect((children.body.rows as { id: string; parent: string }[]).map((row) => row.id)).toEqual([
      "a",
    ]);
    expect(children.body.hidden).toBe(1);
    const none = await get("/v1/objects?parent=group:nothing");
    expect(none.body.rows).toEqual([]);
    expect((await get("/v1/objects")).status).toBe(400);

    store.put("group", "g3", { title: "G3" }, "seed");
    store.put("leaf", "x", { state: "open", parent: "group:g3" }, "seed");
    store.put("leaf", "y", { state: "open", parent: "group:g3", after: ["x"] }, "seed");
    store.put("leaf", "z", { state: "open", parent: "group:g3", after: ["x", 7] }, "seed");
    store.put("leaf", "w", { state: "open", parent: "group:g3", after: [""] }, "seed");
    store.put("leaf", "v", { state: "open", parent: "group:g3", after: "x" }, "seed");
    const level = (await get("/v1/objects?type=leaf&filter=all")).body.rows as { id: string; state: string; after?: string[] }[];
    const byId = (id: string) => level.find((row) => row.id === id);
    expect(byId("y")?.after).toEqual(["x"]);
    expect(byId("x") !== undefined && "after" in (byId("x") ?? {})).toBe(false);
    for (const bad of ["z", "w", "v"]) {
      expect(byId(bad)?.state).toBe("error");
      expect(byId(bad)?.after).toBeUndefined();
    }
    const one = await get("/v1/objects/leaf:y");
    expect((one.body.row as { after?: string[] }).after).toEqual(["x"]);
  });
});
