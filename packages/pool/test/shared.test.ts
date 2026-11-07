import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilePlaces, type Claim } from "../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const claim = (own: string): Claim => ({ own: `count:${own}`, ownLimit: 5, home: "harness:h", homeLimit: 1 });

describe("FilePlaces", () => {
  test("two instances with separate memory share the home cap", async () => {
    const dir = join(await tempRoot(), "pool");
    // Each step's worker thread builds its own instance: nothing is shared but the files.
    const one = new FilePlaces(dir);
    const two = new FilePlaces(dir);
    const first = await one.claim([claim("a")]);
    expect(first.kind).toBe("taken");
    const second = await two.claim([claim("b")]);
    expect(second).toMatchObject({ kind: "blocked", full: ["home"] });
    if (first.kind !== "taken" || second.kind !== "blocked") throw new Error("unexpected");

    const woken = two.changed(second.stamp, new AbortController().signal);
    await first.release();
    expect(await woken).toBe(true);
    expect((await two.claim([claim("b")])).kind).toBe("taken");
  });

  test("the flow count is shared too", async () => {
    const dir = join(await tempRoot(), "pool");
    const wide = (own: string): Claim => ({ own: `count:${own}`, ownLimit: 1, home: "harness:h", homeLimit: undefined });
    expect((await new FilePlaces(dir).claim([wide("a")])).kind).toBe("taken");
    expect(await new FilePlaces(dir).claim([wide("a")])).toMatchObject({ kind: "blocked", full: ["flow"] });
  });

  test("an abort ends the wait", async () => {
    const dir = join(await tempRoot(), "pool");
    const places = new FilePlaces(dir);
    await places.claim([claim("a")]);
    const blocked = await places.claim([claim("a")]);
    if (blocked.kind !== "blocked") throw new Error("unexpected");
    const controller = new AbortController();
    const wait = places.changed(blocked.stamp, controller.signal);
    controller.abort();
    expect(await wait).toBe(false);
  });

  test("a place held by a process that is gone is dropped", async () => {
    const dir = join(await tempRoot(), "pool");
    const child = spawnSync(process.execPath, ["-e", ""]);
    const gone = child.pid;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "places.json"),
      JSON.stringify({ version: 1, held: [{ id: "x", pid: gone, keys: ["count:a", "harness:h"] }] }),
    );
    expect((await new FilePlaces(dir).claim([claim("a")])).kind).toBe("taken");
  });
});
