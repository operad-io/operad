import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SqlitePluginStore,
  createViews,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  startHttpServer,
  storeRootOf,
  type HttpServerHandle,
  type Views,
} from "@operad-io/engine";
import { gitOrThrow, makeRemote } from "../git-support.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  osTempRoot,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const PLUGIN = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const CHAT = fileURLToPath(new URL("../../../chat/src/index.ts", import.meta.url));

interface Rig {
  readonly home: string;
  readonly base: string;
  readonly token: string;
  act(body: unknown): Promise<Response>;
  rows(): Promise<readonly { id: string; title: string }[]>;
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify({
      plugins: [CHAT, PLUGIN],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    })}\n`,
  );
  const config = await readConfig(home);
  const store = new SqlitePluginStore({ root: storeRootOf(config) });
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({ home, store });
  const views: Views = createViews({
    registry,
    store,
    log,
    home,
    onLog: () => undefined,
  });
  let server: HttpServerHandle | undefined;
  try {
    server = await startHttpServer({
      home,
      config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
      views,
      log,
      registry,
      onLog: () => undefined,
    });
    const token = await readHttpToken(home);
    if (token === undefined) throw new Error("the server created no token");
    const base = server.urls[0];
    if (base === undefined) throw new Error("the server bound no address");
    const headers = {
      authorization: `Bearer ${token.token}`,
      "content-type": "application/json",
    };
    await body({
      home,
      base,
      token: token.token,
      act: (value) =>
        fetch(`${base}/v1/act`, {
          method: "POST",
          headers,
          body: JSON.stringify(value),
        }),
      rows: async () => {
        const response = await fetch(`${base}/v1/objects?type=repo`, { headers });
        expect(response.status).toBe(200);
        return ((await response.json()) as { rows: { id: string; title: string }[] }).rows;
      },
    });
  } finally {
    await server?.stop();
    views.close();
    await log.close();
  }
}

async function message(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

describe("registering a repository through dev:repo-add over HTTP", () => {
  test("it asks to confirm, registers a git work tree with a bare remote, and the repo object lists", async () => {
    await withRig(async (rig) => {
      const root = await tempRoot();
      const remote = await makeRemote(root);

      const refused = await rig.act({
        action: "dev:repo-add",
        args: { path: remote.repository },
      });
      expect(refused.status).toBe(409);
      expect(await message(refused)).toContain("needs confirmation");
      expect(await rig.rows()).toEqual([]);

      const added = await rig.act({
        action: "dev:repo-add",
        args: { path: remote.repository },
        confirmed: true,
      });
      expect(added.status).toBe(200);
      const result = (await added.json()) as { value: string };
      expect(result.value).toBe(`added repository (${remote.repository})`);
      expect((await rig.rows()).map((row) => row.id)).toEqual(["repository"]);
    });
  });

  test("a directory that is not a git work tree is refused in the command's words", async () => {
    await withRig(async (rig) => {
      const root = await osTempRoot();
      const plain = join(root, "plain");
      mkdirSync(plain, { recursive: true });
      const refused = await rig.act({
        action: "dev:repo-add",
        args: { path: plain },
        confirmed: true,
      });
      expect(refused.status).toBe(422);
      expect(await message(refused)).toContain(
        `"${plain}" is not a git work tree`,
      );
      expect(await rig.rows()).toEqual([]);
    });
  });

  test("a git work tree with no remote is refused in the command's words", async () => {
    await withRig(async (rig) => {
      const root = await tempRoot();
      const path = join(root, "no-remote");
      mkdirSync(path, { recursive: true });
      gitOrThrow(path, ["init", "-q", "-b", "main"]);
      const refused = await rig.act({
        action: "dev:repo-add",
        args: { path },
        confirmed: true,
      });
      expect(refused.status).toBe(422);
      expect(await message(refused)).toContain(`"${path}" has no remote`);
      expect(await rig.rows()).toEqual([]);
    });
  });

  test("a repository that is already registered is refused in the command's words", async () => {
    await withRig(async (rig) => {
      const root = await tempRoot();
      const remote = await makeRemote(root);
      const first = await rig.act({
        action: "dev:repo-add",
        args: { path: remote.repository },
        confirmed: true,
      });
      expect(first.status).toBe(200);

      const again = await rig.act({
        action: "dev:repo-add",
        args: { path: remote.repository },
        confirmed: true,
      });
      expect(again.status).toBe(422);
      expect(await message(again)).toContain(
        `repository "repository" is already registered at "${remote.repository}"`,
      );
      expect((await rig.rows()).map((row) => row.id)).toEqual(["repository"]);
    });
  });

  test("the path is the one on the serve's machine and the name is optional", async () => {
    await withRig(async (rig) => {
      const root = await tempRoot();
      const remote = await makeRemote(root);

      const added = await rig.act({
        action: "dev:repo-add",
        args: { path: remote.repository, name: "chosen" },
        confirmed: true,
      });
      expect(added.status).toBe(200);
      expect(((await added.json()) as { value: string }).value).toBe(
        `added chosen (${remote.repository})`,
      );
      expect((await rig.rows()).map((row) => row.id)).toEqual(["chosen"]);
    });
  });

  test("a body without a path is refused by the action's schema", async () => {
    await withRig(async (rig) => {
      const refused = await rig.act({
        action: "dev:repo-add",
        args: {},
        confirmed: true,
      });
      expect(refused.status).toBe(400);
      expect(await message(refused)).toContain("args.path: is required");
    });
  });
});
