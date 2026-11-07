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

  test("places taken in the same millisecond by separate instances have distinct ids", async () => {
    const dir = join(await tempRoot(), "pool");
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const wide = (own: string): Claim => ({ own: `count:${own}`, ownLimit: 5, home: "harness:h", homeLimit: undefined });
      const one = await new FilePlaces(dir).claim([wide("a")]);
      const two = await new FilePlaces(dir).claim([wide("a")]);
      if (one.kind !== "taken" || two.kind !== "taken") throw new Error("unexpected");
      await one.release();
      // The other holder is still counted against a limit of one.
      const limited: Claim = { own: "count:a", ownLimit: 1, home: "harness:h", homeLimit: undefined };
      expect(await new FilePlaces(dir).claim([limited])).toMatchObject({ kind: "blocked", full: ["flow"] });
      await two.release();
    } finally {
      Date.now = realNow;
    }
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

describe("FilePlaces leases", () => {
  test("a place whose holder stopped beating is dropped, and a live one is kept beating", async () => {
    const dir = join(await tempRoot(), "pool");
    let now = 1000;
    const options = { now: () => now, heartbeatMs: 20, leaseMs: 100 };
    // A holder in this very process (a killed step thread shares the pid) that never beats.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "places.json"),
      JSON.stringify({ version: 1, held: [{ id: "orphan", pid: process.pid, beat: 1000, keys: ["count:a", "harness:h"] }] }),
    );
    const places = new FilePlaces(dir, options);
    expect((await places.claim([claim("a")])).kind).toBe("blocked");
    now = 1500;
    const taken = await places.claim([claim("a")]);
    expect(taken.kind).toBe("taken");
    if (taken.kind !== "taken") throw new Error("unexpected");
    // The new holder beats while time moves on, so it stays.
    for (let step = 0; step < 5; step += 1) {
      now += 50;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(await new FilePlaces(dir, options).claim([claim("b")])).toMatchObject({ kind: "blocked", full: ["home"] });
    await taken.release();
  });

  test("pruning a dead holder is written, so a waiter does not see a changed version at once", async () => {
    const dir = join(await tempRoot(), "pool");
    const child = spawnSync(process.execPath, ["-e", ""]);
    mkdirSync(dir, { recursive: true });
    const live = { id: "l", pid: process.pid, beat: Date.now(), keys: ["count:a", "harness:h"] };
    const dead = { id: "d", pid: child.pid, beat: Date.now(), keys: ["count:z", "harness:z"] };
    writeFileSync(join(dir, "places.json"), JSON.stringify({ version: 1, held: [dead, live] }));
    const places = new FilePlaces(dir);
    const blocked = await places.claim([claim("a")]);
    if (blocked.kind !== "blocked") throw new Error("unexpected");
    const controller = new AbortController();
    const wait = places.changed(blocked.stamp, controller.signal);
    const early = await Promise.race([wait, new Promise((resolve) => setTimeout(() => resolve("waiting"), 200))]);
    expect(early).toBe("waiting");
    controller.abort();
  });
});
