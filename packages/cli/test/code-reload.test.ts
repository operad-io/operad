import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  CodeWatch,
  describeChange,
  fingerprintCode,
  listPending,
  MemoryPluginStore,
  newHashCache,
  olderCodeNotice,
  openLog,
  PluginRegistry,
  serveLockPath,
  type CodeChange,
} from "../../engine/src/index.ts";
import { fakeClock } from "../../engine/src/testing/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import {
  serveSnapshots,
  listenForStop,
  loadsAsWellAs,
  problemKey,
  takeCodeSnapshot,
  type CodeSnapshot,
} from "../src/code-reload.ts";

afterAll(cleanupTempRoots);

describe("what counts as loading", () => {
  test("a problem is the same one only when it says the same thing", () => {
    expect(problemKey('plugin "dev": import failed: x.ts?operad-plugin-load=3')).toBe(
      problemKey('plugin "dev": import failed: x.ts?operad-plugin-load=9'),
    );
    expect(problemKey('plugin "dev": onTick failed: boom')).not.toBe(
      problemKey('plugin "dev": import failed: boom'),
    );
  });

  test("a message that spans lines is the same problem as its one-line form", () => {
    expect(problemKey("plugin a: failed\n  at x")).toBe(problemKey("plugin a: failed at x"));
    expect(loadsAsWellAs(["plugin a: failed at x"], ["plugin a: failed\n  at x"])).toBe(true);
  });

  test("no problems loads; a new problem does not; a known one does", () => {
    expect(loadsAsWellAs([], [])).toBe(true);
    expect(loadsAsWellAs(['plugin "a": import failed'], [])).toBe(false);
    expect(loadsAsWellAs(['plugin "a": import failed'], ['plugin "a": import failed'])).toBe(true);
    expect(loadsAsWellAs(['plugin "a": import failed: new'], ['plugin "a": import failed'])).toBe(false);
    expect(loadsAsWellAs(['plugin "b": import failed'], ['plugin "a": import failed'])).toBe(false);
  });
});

/** A plugin package with one source file, returned with its directory. */
function pluginPackage(root: string, name: string): { file: string; directory: string } {
  const directory = join(root, name);
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name }));
  const file = join(directory, "src", "index.ts");
  writeFileSync(file, "export default 1;\n");
  return { file, directory };
}

/** A watch the test fires by hand. */
function fakeWatch(): {
  readonly watch: (directory: string, onChange: (name: string | null) => void) => () => void;
  readonly fire: () => void;
} {
  const listeners = new Set<(name: string | null) => void>();
  return {
    watch: (_directory, onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    fire: () => {
      for (const listener of [...listeners]) listener(null);
    },
  };
}

/** Lets the check that a fired timer started finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function watchSnapshot(
  snapshot: CodeSnapshot,
  changes: CodeChange[],
): { clock: ReturnType<typeof fakeClock>; events: ReturnType<typeof fakeWatch>; watch: CodeWatch } {
  const clock = fakeClock();
  const events = fakeWatch();
  const watch = new CodeWatch({
    roots: snapshot.roots,
    baseline: snapshot.baseline,
    quietMs: 100,
    pollMs: 10_000,
    clock,
    watch: events.watch,
    onChange: async (change) => {
      changes.push(change);
      return "reload";
    },
  });
  watch.start();
  return { clock, events, watch };
}

describe("plugin code in a serve snapshot", () => {
  test("a change under an enabled plugin's package is seen and reloads", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const plugin = pluginPackage(root, "enabled");
    const snapshot = takeCodeSnapshot(home, [
      { name: "enabled", module: plugin.file, enabled: true },
    ]);
    const changes: CodeChange[] = [];
    const w = watchSnapshot(snapshot, changes);
    try {
      // A change with no folder event still wakes the fallback check.
      writeFileSync(plugin.file, "export default 2;\n");
      w.clock.advance(10_000);
      w.clock.advance(100);
      await settle();
      expect(changes).toHaveLength(1);
      expect(describeChange(changes[0])).toStartWith("plugin enabled: ");
      expect(describeChange(changes[0])).toContain("src/index.ts");
    } finally {
      w.watch.stop();
    }
  });

  test("a change under a disabled plugin's package is not seen", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const enabled = pluginPackage(root, "enabled");
    const disabled = pluginPackage(root, "disabled");
    const snapshot = takeCodeSnapshot(home, [
      { name: "enabled", module: enabled.file, enabled: true },
      { name: "disabled", module: disabled.file, enabled: false },
    ]);
    expect(snapshot.roots.map((entry) => entry.path)).not.toContain(disabled.directory);

    const changes: CodeChange[] = [];
    const w = watchSnapshot(snapshot, changes);
    try {
      writeFileSync(disabled.file, "export default 2;\n");
      w.events.fire();
      w.clock.advance(100);
      await settle();
      expect(changes).toHaveLength(0);
    } finally {
      w.watch.stop();
    }
  });
});


describe("a serve restored after a restart could not listen", () => {
  /**
   * The wiring of `serve`: the process snapshots its code when it first serves,
   * a restored serve takes that first snapshot as its baseline, and the code
   * watch reports into the notice that `pending` shows.
   */
  async function scenario(changed: "engine" | "plugin") {
    const home = await tempRoot();
    const roots = ["engine", "plugin"].map((name) => {
      const path = join(home, name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "index.ts"), "export const v = 1;\n");
      return { label: name, path };
    });
    const snapshotOf = serveSnapshots();
    const take = (): CodeSnapshot => {
      const cache = newHashCache();
      return { roots, baseline: fingerprintCode(roots, cache), cache };
    };
    // The first serve loads the code, then a file changes and its restart fails to listen.
    snapshotOf(take(), false);
    writeFileSync(join(home, changed, "index.ts"), "export const v = 2;\n");

    const storeRoot = join(home, "store");
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const registry = new PluginRegistry([], {
      home,
      storeRoot,
      store: new MemoryPluginStore({ root: storeRoot }),
      onLog: () => undefined,
    });
    const lock = acquireLock(serveLockPath(home));
    const notice = olderCodeNotice(home);
    const serve = async (restored: boolean): Promise<readonly string[]> => {
      notice.clear();
      const snapshot = snapshotOf(take(), restored);
      const clock = fakeClock();
      const watch = new CodeWatch({
        roots: snapshot.roots,
        baseline: snapshot.baseline,
        declined: snapshot.tried,
        quietMs: 100,
        pollMs: 1_000,
        clock,
        watch: () => () => undefined,
        onOlder: notice.report,
        onChange: async () => "keep",
      });
      watch.start();
      clock.advance(1_000);
      clock.advance(100);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      const items = (await listPending(log, registry)).map((item) => item.prompt);
      watch.stop();
      return items;
    };
    return {
      serve,
      done: async () => {
        lock.release();
        await log.close();
      },
    };
  }

  for (const changed of ["engine", "plugin"] as const) {
    test(`a changed ${changed} file shows the item; a serve that restarted on the new code shows none`, async () => {
      const s = await scenario(changed);
      const restored = await s.serve(true);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toContain("serve runs older code than the files on disk");
      // A successful restart takes a fresh snapshot of what is on disk.
      expect(await s.serve(false)).toEqual([]);
      await s.done();
    });
  }
});

describe("the stop signal handlers of a serve", () => {
  test("a supervised serve keeps them after its stop is done; another serve does not", () => {
    const stop = (): void => undefined;
    const intBefore = process.listenerCount("SIGINT");
    const termBefore = process.listenerCount("SIGTERM");

    const supervised = listenForStop(true, stop);
    supervised();
    expect(process.listenerCount("SIGINT")).toBe(intBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(termBefore + 1);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);

    const alone = listenForStop(false, stop);
    expect(process.listenerCount("SIGINT")).toBe(intBefore + 1);
    alone();
    expect(process.listenerCount("SIGINT")).toBe(intBefore);
    expect(process.listenerCount("SIGTERM")).toBe(termBefore);
  });
});
