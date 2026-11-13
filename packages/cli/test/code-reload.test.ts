import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeWatch, describeChange, diffFingerprints, ENGINE_CODE_ROOT, type CodeChange } from "../../engine/src/index.ts";
import { fakeClock } from "../../engine/src/testing/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import {
  CLI_CODE_ROOT,
  keepKernelBaseline,
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
  test("the kernel files keep the hashes the process loaded; plugin files take the current ones", () => {
    const kernelFile = join(ENGINE_CODE_ROOT.path, "src", "index.ts");
    const pluginFile = "/elsewhere/plugin.ts";
    const earlier = {
      hashes: new Map([[kernelFile, "old"], [pluginFile, "old"]]),
      labels: new Map([[kernelFile, "engine"], [pluginFile, "plugin x"]]),
      directories: new Set<string>(),
    };
    const roots = [ENGINE_CODE_ROOT, CLI_CODE_ROOT];
    const now = {
      roots,
      cache: takeCodeSnapshot(".", []).cache,
      baseline: {
        hashes: new Map([[kernelFile, "new"], [pluginFile, "new"]]),
        labels: new Map([[kernelFile, "engine"], [pluginFile, "plugin x"]]),
        directories: new Set<string>(),
      },
    };
    const kept = keepKernelBaseline(now, earlier);
    expect(kept.baseline.hashes.get(kernelFile)).toBe("old");
    expect(kept.baseline.hashes.get(pluginFile)).toBe("new");
    expect(diffFingerprints(kept.baseline, now.baseline)?.files).toEqual([kernelFile]);
  });
});
