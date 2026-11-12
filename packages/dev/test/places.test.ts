import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginStepResult } from "@operad-io/engine";
import {
  checkPlacesDirectory,
  checkPlacesOf,
  DEFAULT_CHECK_PLACES,
  VERIFY_STARVATION_MS,
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
    await until(() => started.length === 1);
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

describe("check places are served in the order checks began to wait", () => {
  const waiters = (home: string): string[] =>
    readdirSync(checkPlacesDirectory(home)).filter((name) => name.endsWith(".wait"));

  /** Starts a check that began to wait at `time` and has its own bell, so a test decides who looks. */
  function waiter(
    home: string,
    name: string,
    time: number,
    started: string[],
    extra: Partial<CheckPlaces> = {},
  ) {
    const rings = bell();
    const watcher = logWatcher();
    const orders: { since: number; ahead: number }[] = [];
    const gate = deferred();
    const done = withCheckPlace(
      {
        home,
        checks: 1,
        log: watcher.log,
        wait: rings.wait,
        clock: () => time,
        waiting: (key, order) => {
          if (key !== null && order !== undefined) orders.push(order);
          return Promise.resolve();
        },
        ...extra,
      },
      async () => {
        started.push(name);
        await gate.promise;
      },
    );
    return { rings, watcher, orders, gate, done };
  }

  async function holdPlace(home: string): Promise<{ release: () => Promise<void> }> {
    const hold = deferred();
    let holding = false;
    const holder = withCheckPlace({ home, checks: 1, log: () => {} }, () => {
      holding = true;
      return hold.promise;
    });
    await until(() => holding);
    return {
      release: async () => {
        hold.resolve();
        await holder;
      },
    };
  }

  test("a, b, c take places in the order they began to wait, even when c looks first", async () => {
    const home = await osTempRoot();
    const holder = await holdPlace(home);
    const started: string[] = [];
    const a = waiter(home, "a", 1, started);
    await a.watcher.seen("waiting for a check place");
    const b = waiter(home, "b", 2, started);
    await b.watcher.seen("waiting for a check place");
    const c = waiter(home, "c", 3, started);
    await c.watcher.seen("waiting for a check place");
    // The ahead count follows the order: a has nobody before it, c has a and b.
    await until(() => c.orders.length > 0);
    expect([a.orders.at(-1)?.ahead, b.orders.at(-1)?.ahead, c.orders.at(-1)?.ahead]).toEqual([0, 1, 2]);
    expect(c.orders.at(-1)?.since).toBe(3);

    await holder.release();
    c.rings.ring();
    b.rings.ring();
    await c.watcher.seen("2 ahead");
    expect(started).toEqual([]);
    a.rings.ring();
    await until(() => started.length === 1);
    expect(started).toEqual(["a"]);

    c.rings.ring();
    await c.watcher.seen("1 ahead");
    expect(started).toEqual(["a"]);
    a.gate.resolve();
    await a.done;
    const looks = c.orders.length;
    c.rings.ring();
    await until(() => c.orders.length > looks);
    expect(started).toEqual(["a"]);
    b.rings.ring();
    await until(() => started.length === 2);
    expect(started).toEqual(["a", "b"]);
    b.gate.resolve();
    await b.done;
    c.rings.ring();
    await until(() => started.length === 3);
    c.gate.resolve();
    await c.done;
    expect(started).toEqual(["a", "b", "c"]);
    expect(waiters(home)).toEqual([]);
  });

  test("a waiting check tells the kernel how many are ahead of it in the order", async () => {
    const home = await osTempRoot();
    const holder = await holdPlace(home);
    const started: string[] = [];
    const told: { key: string; ahead: number | undefined }[] = [];
    const queued = (key: string, ahead?: number) => {
      told.push({ key, ahead });
      return Promise.resolve(() => Promise.resolve());
    };
    // The earlier check has not reported to the kernel at all; the later one still says 1 ahead.
    const first = waiter(home, "first", 1, started);
    await first.watcher.seen("waiting for a check place");
    const second = waiter(home, "second", 2, started, { queued });
    await until(() => told.length === 1);
    expect(told).toEqual([{ key: "check place", ahead: 1 }]);
    // The first one leaves the order; the second says it is now first.
    await holder.release();
    first.rings.ring();
    await until(() => started.length === 1);
    first.gate.resolve();
    await first.done;
    second.rings.ring();
    await until(() => started.length === 2);
    expect(told.map((entry) => entry.ahead)).toEqual([1]);
    second.gate.resolve();
    await second.done;
  });

  test("a waiter whose process is dead is skipped and its entry removed", async () => {
    const home = await osTempRoot();
    const child = Bun.spawn({ cmd: [process.execPath, "-e", ""], stdout: "ignore", stderr: "ignore" });
    await child.exited;
    const directory = checkPlacesDirectory(home);
    await Bun.write(join(directory, ".keep"), "");
    const dead = `queue-home-${String(0).padStart(16, "0")}-${child.pid}-dead.wait`;
    writeFileSync(join(directory, dead), "");
    expect(waiters(home)).toEqual([dead]);
    const started: string[] = [];
    const only = waiter(home, "only", 5, started);
    await until(() => started.length === 1);
    only.gate.resolve();
    await only.done;
    expect(started).toEqual(["only"]);
    expect(waiters(home)).toEqual([]);
  });

  test("a cancelled waiter leaves the order at once", async () => {
    const home = await osTempRoot();
    const holder = await holdPlace(home);
    const started: string[] = [];
    const controller = new AbortController();
    const a = waiter(home, "a", 1, started, { signal: controller.signal });
    await a.watcher.seen("waiting for a check place");
    const b = waiter(home, "b", 2, started);
    await b.watcher.seen("waiting for a check place");
    expect(waiters(home).length).toBe(2);
    controller.abort();
    // Before anyone looks again: a's entry is already gone.
    expect(waiters(home).length).toBe(1);
    a.rings.ring();
    await expect(a.done).rejects.toThrow("cancelled while waiting");
    await holder.release();
    b.rings.ring();
    await until(() => started.length === 1);
    expect(started).toEqual(["b"]);
    b.gate.resolve();
    await b.done;
    expect(waiters(home)).toEqual([]);
  });

  test("integration checks take a freed place before verify checks, each first come first served", async () => {
    const home = await osTempRoot();
    const holder = await holdPlace(home);
    const started: string[] = [];
    const firstVerify = waiter(home, "v1", 1, started);
    await firstVerify.watcher.seen("waiting for a check place");
    const firstIntegration = waiter(home, "i1", 2, started, { kind: "integration" });
    await firstIntegration.watcher.seen("waiting for a check place");
    const secondVerify = waiter(home, "v2", 3, started);
    await secondVerify.watcher.seen("waiting for a check place");
    const secondIntegration = waiter(home, "i2", 4, started, { kind: "integration" });
    await secondIntegration.watcher.seen("waiting for a check place");

    await until(() => secondIntegration.orders.length > 0);
    expect(firstIntegration.orders.at(-1)?.ahead).toBe(0);
    // Both integrations are ahead of both verifies.
    expect(secondIntegration.orders.at(-1)?.ahead).toBe(1);

    await holder.release();
    secondIntegration.rings.ring();
    firstIntegration.rings.ring();
    secondVerify.rings.ring();
    firstVerify.rings.ring();
    await until(() => started.length === 1);
    expect(started).toEqual(["i1"]);
    // The verify waited first, but the integration took the place.
    await firstVerify.watcher.seen("passed over for an integration check");
    firstIntegration.gate.resolve();
    await firstIntegration.done;
    secondIntegration.rings.ring();
    await until(() => started.length === 2);
    expect(started).toEqual(["i1", "i2"]);
    secondIntegration.gate.resolve();
    await secondIntegration.done;

    // With no integration left, the verifies run in the order they began to wait.
    secondVerify.rings.ring();
    firstVerify.rings.ring();
    await until(() => started.length === 3);
    expect(started).toEqual(["i1", "i2", "v1"]);
    firstVerify.gate.resolve();
    await firstVerify.done;
    secondVerify.rings.ring();
    await until(() => started.length === 4);
    expect(started).toEqual(["i1", "i2", "v1", "v2"]);
    secondVerify.gate.resolve();
    await secondVerify.done;
    expect(waiters(home)).toEqual([]);
  });

  test("a verify that has waited longer than the limit takes the next place before an integration", async () => {
    const home = await osTempRoot();
    const now = { value: 1_000_000 };
    const holder = await holdPlace(home);
    const started: string[] = [];
    const verify = waiter(home, "verify", now.value, started, { clock: () => now.value });
    await verify.watcher.seen("waiting for a check place");
    now.value += 2_000;
    const integration = waiter(home, "integration", now.value, started, {
      kind: "integration",
      clock: () => now.value,
    });
    await integration.watcher.seen("waiting for a check place");
    await until(() => integration.orders.length > 0);
    // The verify has not reached the limit yet: the integration is first.
    expect(integration.orders.at(-1)?.ahead).toBe(0);

    now.value = 1_000_000 + VERIFY_STARVATION_MS + 1;
    integration.rings.ring();
    await until(() => integration.orders.at(-1)?.ahead === 1);

    await holder.release();
    // The integration looks first, but the starved verify takes the free place.
    integration.rings.ring();
    verify.rings.ring();
    await until(() => started.length === 1);
    expect(started).toEqual(["verify"]);
    verify.gate.resolve();
    await verify.done;

    integration.rings.ring();
    await until(() => started.length === 2);
    expect(started).toEqual(["verify", "integration"]);
    integration.gate.resolve();
    await integration.done;
    expect(waiters(home)).toEqual([]);
  });

  test("the repository's own pool follows the order too", async () => {
    const home = await osTempRoot();
    const repository = { name: "ios", path: "/r/ios", places: 1 };
    const hold = deferred();
    let holding = false;
    const holder = withCheckPlace({ home, checks: 3, repository, log: () => {} }, () => {
      holding = true;
      return hold.promise;
    });
    await until(() => holding);
    const started: string[] = [];
    const first = waiter(home, "first", 1, started, { checks: 3, repository });
    await first.watcher.seen("check place of ios");
    const second = waiter(home, "second", 2, started, { checks: 3, repository });
    await second.watcher.seen("check place of ios");
    expect(second.orders.at(-1)?.ahead).toBe(1);
    hold.resolve();
    await holder;
    second.rings.ring();
    await second.watcher.seen("1 ahead");
    expect(started).toEqual([]);
    first.rings.ring();
    await until(() => started.length === 1);
    expect(started).toEqual(["first"]);
    first.gate.resolve();
    await first.done;
    second.rings.ring();
    await until(() => started.length === 2);
    second.gate.resolve();
    await second.done;
    expect(waiters(home)).toEqual([]);
  });
});
