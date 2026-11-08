import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { PluginStepResult } from "@operad-io/engine";
import {
  checkPlacesOf,
  DEFAULT_CHECK_PLACES,
  withCheckPlace,
  type CheckPlaces,
} from "../src/places.ts";
import { runCheckWithRerun } from "../src/rerun.ts";
import { cleanupTempRoots, guardLockHandles, osTempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const CHILD = fileURLToPath(new URL("./fixtures/place-child.ts", import.meta.url));

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A wait that returns when the test says something changed, even if it said so first. */
function bell(): { readonly wait: () => Promise<void>; readonly ring: () => void } {
  let rung = false;
  let current = deferred();
  return {
    wait: () => {
      if (rung) {
        rung = false;
        return Promise.resolve();
      }
      return current.promise;
    },
    ring: () => {
      rung = true;
      const old = current;
      current = deferred();
      old.resolve();
    },
  };
}

/** Resolves when `lines` holds a line that contains `text`. */
function logWatcher(): {
  readonly lines: string[];
  readonly log: (line: string) => void;
  readonly seen: (text: string) => Promise<void>;
} {
  const lines: string[] = [];
  const waiting: { text: string; done: () => void }[] = [];
  return {
    lines,
    log: (line) => {
      lines.push(line);
      for (const w of waiting.filter((entry) => line.includes(entry.text))) w.done();
    },
    seen: (text) =>
      lines.some((line) => line.includes(text))
        ? Promise.resolve()
        : new Promise<void>((done) => waiting.push({ text, done })),
  };
}

describe("check places", () => {
  test("the limit is 2 unless the home's settings say otherwise", () => {
    expect(checkPlacesOf({})).toBe(DEFAULT_CHECK_PLACES);
    expect(checkPlacesOf({ checks: 3 })).toBe(3);
    expect(() => checkPlacesOf({ checks: 0 })).toThrow("positive integer");
  });

  test("three checks with a limit of 2: two run, the third waits until one ends", async () => {
    const home = await osTempRoot();
    const watcher = logWatcher();
    const rings = bell();
    const places: CheckPlaces = {
      home,
      checks: 2,
      log: watcher.log,
      wait: rings.wait,
    };
    const started: string[] = [];
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    const run = (name: keyof typeof gates): Promise<string> =>
      withCheckPlace(places, async () => {
        started.push(name);
        await gates[name].promise;
        return name;
      });

    const first = run("a");
    const second = run("b");
    await until(() => started.length === 2);
    const third = run("c");
    await watcher.seen("waiting for a check place: 2 in use");
    expect(started).toEqual(["a", "b"]);

    gates.a.resolve();
    expect(await first).toBe("a");
    rings.ring();
    await until(() => started.length === 3);
    expect(started).toEqual(["a", "b", "c"]);
    gates.b.resolve();
    gates.c.resolve();
    expect(await Promise.all([second, third])).toEqual(["b", "c"]);
    expect(watcher.lines).toEqual(["waiting for a check place: 2 in use"]);
  });

  test("a place is given back when the work throws", async () => {
    const home = await osTempRoot();
    const places: CheckPlaces = { home, checks: 1, log: () => {} };
    await expect(
      withCheckPlace(places, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withCheckPlace(places, () => "again")).toBe("again");
  });

  test("a killed check releases its place", async () => {
    const home = await osTempRoot();
    const children = [0, 1].map(() =>
      Bun.spawn({
        cmd: [process.execPath, CHILD, home, "2"],
        stdout: "pipe",
        stderr: "inherit",
      }),
    );
    try {
      for (const child of children) {
        const reader = child.stdout.getReader();
        const chunk = await reader.read();
        expect(new TextDecoder().decode(chunk.value)).toBe("held\n");
        reader.releaseLock();
      }
      const watcher = logWatcher();
      const rings = bell();
      let ran = false;
      const waiting = withCheckPlace(
        { home, checks: 2, log: watcher.log, wait: rings.wait },
        () => {
          ran = true;
        },
      );
      await watcher.seen("waiting for a check place: 2 in use");
      expect(ran).toBe(false);

      children[0]?.kill("SIGKILL");
      await children[0]?.exited;
      rings.ring();
      await waiting;
      expect(ran).toBe(true);
    } finally {
      for (const child of children) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });

  test("a cancelled step stops waiting for a place", async () => {
    const home = await osTempRoot();
    const controller = new AbortController();
    const watcher = logWatcher();
    const rings = bell();
    const hold = deferred();
    let holding = false;
    const holder = withCheckPlace({ home, checks: 1, log: () => {} }, () => {
      holding = true;
      return hold.promise;
    });
    await until(() => holding);
    const waiting = withCheckPlace(
      { home, checks: 1, log: watcher.log, wait: rings.wait, signal: controller.signal },
      () => "never",
    );
    await watcher.seen("waiting for a check place: 1 in use");
    controller.abort();
    rings.ring();
    await expect(waiting).rejects.toThrow("cancelled while waiting");
    hold.resolve();
    await holder;
  });

  test("a check waits for a place before its command starts", async () => {
    const home = await osTempRoot();
    const watcher = logWatcher();
    const rings = bell();
    const hold = deferred();
    let holding = false;
    const holder = withCheckPlace({ home, checks: 1, log: () => {} }, () => {
      holding = true;
      return hold.promise;
    });
    await until(() => holding);
    let ran = false;
    const checked = runCheckWithRerun(
      async (): Promise<PluginStepResult> => {
        ran = true;
        return { result: "pass", data: {} };
      },
      {},
      { runId: "r" },
      0,
      { home, checks: 1, log: watcher.log, wait: rings.wait },
    );
    await watcher.seen("waiting for a check place: 1 in use");
    expect(ran).toBe(false);
    hold.resolve();
    await holder;
    rings.ring();
    expect((await checked).outcome?.result).toBe("pass");
    expect(ran).toBe(true);
  });
});

/** Resolves when `ready` is true, looking again each time a microtask turn passes. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise<void>((done) => setImmediate(done));
}
