import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRepositories, registerRequested, registerRequestsDirectory, registerStanding } from "../src/index.ts";
import { cleanupTempRoots, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

async function rig() {
  const root = await tempRoot("dev-register-");
  const home = join(root, "home");
  mkdirSync(registerRequestsDirectory(home), { recursive: true });
  const store = storeAt(root);
  const request = (name: string, path: string): void =>
    writeFileSync(join(registerRequestsDirectory(home), `${name}.json`), `${JSON.stringify({ path })}\n`);
  return { root, home, store, request, ctx: { home, cwd: root, store } };
}

describe("a request to register a repository (Setup Dev)", () => {
  test("is registered on a tick and its file is removed", async () => {
    const r = await rig();
    const repo = await makeGitRepository(r.root);
    r.request("a", repo);
    await registerRequested(r.ctx);
    expect((await listRepositories(r.store)).map((item) => item.name)).toEqual(["repository"]);
    expect(readdirSync(registerRequestsDirectory(r.home))).toEqual([]);
    // The dev.json the proposal wrote is kept: registering does not replace it.
    expect(existsSync(join(repo, ".operad", "dev.json"))).toBe(true);
  });

  test("one that cannot be registered stays with its reason, and is a pending item until fixed", async () => {
    const r = await rig();
    const missing = join(r.root, "nowhere");
    r.request("a", missing);
    await registerRequested(r.ctx);
    const left = readdirSync(registerRequestsDirectory(r.home));
    expect(left).toEqual(["a.json"]);
    expect(readFileSync(join(registerRequestsDirectory(r.home), "a.json"), "utf8")).toContain("no directory");
    const items = registerStanding(r.home);
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain(missing);

    // Once the directory is a repository, the next tick registers it and the item goes.
    await makeGitRepository(r.root, "nowhere");
    await registerRequested(r.ctx);
    expect(readdirSync(registerRequestsDirectory(r.home))).toEqual([]);
    expect(registerStanding(r.home)).toEqual([]);
  });

  test("a repository that is already registered only has its request removed", async () => {
    const r = await rig();
    const repo = await makeGitRepository(r.root);
    r.request("a", repo);
    await registerRequested(r.ctx);
    r.request("b", repo);
    await registerRequested(r.ctx);
    expect(readdirSync(registerRequestsDirectory(r.home))).toEqual([]);
    expect(await listRepositories(r.store)).toHaveLength(1);
  });
});
