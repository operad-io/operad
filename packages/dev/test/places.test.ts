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
import { validateDevSettings } from "../src/settings.ts";
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

  test("a waiting check tells the kernel and the task its place group until it takes the place", async () => {
    const home = await osTempRoot();
    const rings = bell();
    const hold = deferred();
    let holding = false;
    const holder = withCheckPlace({ home, checks: 1, log: () => {} }, () => {
      holding = true;
      return hold.promise;
    });
    await until(() => holding);
    const events: string[] = [];
    const watcher = logWatcher();
    const waiting = withCheckPlace(
      {
        home,
        checks: 1,
        log: watcher.log,
        wait: rings.wait,
        queued: (key) => {
          events.push(`queued ${key}`);
          return Promise.resolve(() => {
            events.push(`ended ${key}`);
            return Promise.resolve();
          });
        },
        waiting: (key) => {
          events.push(`row ${key}`);
          return Promise.resolve();
        },
      },
      () => {
        events.push("work");
      },
    );
    await watcher.seen("waiting for a check place: 1 in use");
    await until(() => events.includes("row check place"));
    expect(events).toEqual(["queued check place", "row check place"]);
    hold.resolve();
    await holder;
    rings.ring();
    await waiting;
    // The kernel and the row hear it end before the command starts.
    expect(events.slice(0, 5)).toEqual([
      "queued check place",
      "row check place",
      "ended check place",
      "row null",
      "work",
    ]);
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

describe("repository check places", () => {
  const repo = (name: string, places: number) => ({ name, path: `/r/${name}`, places });

  /** Starts checks by name; each holds its place until the test releases it. */
  function rig(home: string, rings: ReturnType<typeof bell>, watcher: ReturnType<typeof logWatcher>) {
    const started: string[] = [];
    const gates = new Map<string, Deferred>();
    const run = (
      name: string,
      checks: number,
      repository: ReturnType<typeof repo>,
    ): Promise<string> =>
      withCheckPlace(
        { home, checks, repository, log: watcher.log, wait: rings.wait },
        async () => {
          started.push(name);
          const gate = deferred();
          gates.set(name, gate);
          await gate.promise;
          return name;
        },
      );
    const release = (name: string): void => gates.get(name)?.resolve();
    return { started, run, release };
  }

  test("two checks of a repository with places 1 take turns while another repository runs beside them", async () => {
    const home = await osTempRoot();
    const watcher = logWatcher();
    const rings = bell();
    const { started, run, release } = rig(home, rings, watcher);
    const ios = repo("operad-ios", 1);
    const one = run("ios1", 3, ios);
    await until(() => started.includes("ios1"));
    const two = run("ios2", 3, ios);
    await watcher.seen("waiting for a check place of operad-ios: 1 in use");
    const other = run("operad", 3, repo("operad", 2));
    await until(() => started.includes("operad"));
    expect(started).toEqual(["ios1", "operad"]);
    release("ios1");
    await one;
    rings.ring();
    await until(() => started.includes("ios2"));
    release("ios2");
    release("operad");
    await Promise.all([two, other]);
  });

  test("the home limit holds with repository limits that would allow more", async () => {
    const home = await osTempRoot();
    const watcher = logWatcher();
    const rings = bell();
    const { started, run, release } = rig(home, rings, watcher);
    const a = run("a", 1, repo("a", 2));
    await until(() => started.includes("a"));
    const b = run("b", 1, repo("b", 2));
    await watcher.seen("waiting for a check place: 1 in use");
    expect(started).toEqual(["a"]);
    release("a");
    await a;
    rings.ring();
    await until(() => started.includes("b"));
    release("b");
    await b;
  });

  test("a check waiting for its repository does not hold a home place", async () => {
    const home = await osTempRoot();
    const watcher = logWatcher();
    const rings = bell();
    const { started, run, release } = rig(home, rings, watcher);
    const ios = repo("ios", 1);
    const first = run("ios1", 2, ios);
    await until(() => started.includes("ios1"));
    const second = run("ios2", 2, ios);
    await watcher.seen("waiting for a check place of ios: 1 in use");
    // The home has two places; the waiting check holds none, so this one runs.
    const third = run("operad", 2, repo("operad", 1));
    await until(() => started.includes("operad"));
    release("operad");
    release("ios1");
    await Promise.all([first, third]);
    rings.ring();
    await until(() => started.includes("ios2"));
    release("ios2");
    await second;
  });

  test("three checks with both limits at 1 finish without deadlock", async () => {
    const home = await osTempRoot();
    const watcher = logWatcher();
    const rings = bell();
    const { started, run, release } = rig(home, rings, watcher);
    const ios = repo("ios", 1);
    const all = [run("x", 1, ios), run("y", 1, ios), run("z", 1, repo("z", 1))];
    for (let finished = 0; finished < 3; finished += 1) {
      await until(() => started.length > finished);
      const name = started[finished];
      if (name === undefined) throw new Error("no check started");
      release(name);
      await all[["x", "y", "z"].indexOf(name)];
      rings.ring();
    }
    expect((await Promise.all(all)).sort()).toEqual(["x", "y", "z"]);
    expect(started.length).toBe(3);

  });

  test("a killed check frees its home place and its repository place", async () => {
    const home = await osTempRoot();
    const child = Bun.spawn({
      cmd: [process.execPath, CHILD, home, "1", "ios", "1"],
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = child.stdout.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toBe("held\n");
      reader.releaseLock();
      const watcher = logWatcher();
      const rings = bell();
      let ran = false;
      const waiting = withCheckPlace(
        { home, checks: 1, repository: { name: "ios", path: "/r/ios", places: 1 }, log: watcher.log, wait: rings.wait },
        () => {
          ran = true;
        },
      );
      await watcher.seen("waiting for a check place: 1 in use");
      expect(ran).toBe(false);
      child.kill("SIGKILL");
      await child.exited;
      rings.ring();
      await waiting;
      expect(ran).toBe(true);
      // The repository's place is free too: the same repository can take it with room at home.
      expect(
        await withCheckPlace(
          { home, checks: 2, repository: { name: "ios", path: "/r/ios", places: 1 }, log: () => {} },
          () => "free",
        ),
      ).toBe("free");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });
});

describe("gate.places setting", () => {
  test("is an integer of 1 or more, and optional", () => {
    expect(validateDevSettings({ name: "r", gate: { places: 1 } }).gate.places).toBe(1);
    expect(validateDevSettings({ name: "r" }).gate.places).toBeUndefined();
    for (const bad of [0, 1.5, "1"]) {
      expect(() => validateDevSettings({ name: "r", gate: { places: bad } })).toThrow(
        "gate.places",
      );
    }
  });
});
