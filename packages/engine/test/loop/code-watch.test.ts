import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodeWatch,
  codeRoots,
  describeChange,
  diffFingerprints,
  fingerprintCode,
  waitForCodeChange,
  type CodeChange,
} from "../../src/index.ts";
import { fakeClock } from "../../src/testing/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

async function project(): Promise<{ root: string; file: string }> {
  const root = await tempRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  const file = join(root, "src", "a.ts");
  writeFileSync(file, "export const a = 1;\n");
  return { root, file };
}

describe("code fingerprints", () => {
  test("a changed, added or removed file differs; the same text written again does not", async () => {
    const { root, file } = await project();
    const roots = [{ label: "pkg", path: root }];
    const before = fingerprintCode(roots);

    writeFileSync(file, "export const a = 1;\n");
    expect(diffFingerprints(before, fingerprintCode(roots))).toBeUndefined();

    writeFileSync(file, "export const a = 2;\n");
    expect(diffFingerprints(before, fingerprintCode(roots))?.files).toEqual([file]);

    writeFileSync(file, "export const a = 1;\n");
    const extra = join(root, "src", "b.ts");
    writeFileSync(extra, "export const b = 1;\n");
    const added = diffFingerprints(before, fingerprintCode(roots));
    expect(added?.files).toEqual([extra]);
    rmSync(extra);
    rmSync(file);
    expect(diffFingerprints(before, fingerprintCode(roots))?.files).toEqual([file]);
  });

  test("docs, tests and fixtures are not code", async () => {
    const { root } = await project();
    const roots = [{ label: "pkg", path: root }];
    const before = fingerprintCode(roots);
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    writeFileSync(join(root, "test", "a.test.ts"), "x");
    writeFileSync(join(root, "README.md"), "x");
    writeFileSync(join(root, "src", "a.test.ts"), "x");
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.ts"), "x");
    expect(diffFingerprints(before, fingerprintCode(roots))).toBeUndefined();
    writeFileSync(join(root, "schema.json"), "{}");
    expect(diffFingerprints(before, fingerprintCode(roots))?.files).toEqual([
      join(root, "schema.json"),
    ]);
  });

  test("a line names the roots that changed", async () => {
    const { root, file } = await project();
    const roots = [{ label: "plugin demo", path: root }];
    const before = fingerprintCode(roots);
    writeFileSync(file, "export const a = 2;\n");
    const change = diffFingerprints(before, fingerprintCode(roots));
    expect(change).toBeDefined();
    expect(describeChange(change as CodeChange)).toBe("plugin demo: src/a.ts");
  });
});

describe("code roots", () => {
  test("a plugin in a package counts with the package; one in a project that holds the home counts alone", async () => {
    const root = await tempRoot();
    const pkg = join(root, "pkg");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(pkg, "src", "index.ts"), "export default 1;\n");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    const apart = codeRoots({
      home,
      plugins: [{ name: "demo", module: join(pkg, "src", "index.ts") }],
    });
    expect(apart.map((entry) => entry.path)).toContain(pkg);

    // The package holds the home: it is the project, not the plugin's code.
    const inside = join(pkg, "home");
    mkdirSync(inside, { recursive: true });
    const together = codeRoots({
      home: inside,
      plugins: [{ name: "demo", module: join(pkg, "src", "index.ts") }],
    });
    expect(together.map((entry) => entry.path)).toContain(join(pkg, "src", "index.ts"));
    expect(together.map((entry) => entry.path)).not.toContain(pkg);
  });
});

/** A watch the test fires by hand. */
function fakeWatch(): {
  readonly watch: (directory: string, onChange: (name: string | null) => void) => () => void;
  readonly fire: () => void;
  readonly open: () => number;
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
    open: () => listeners.size,
  };
}

describe("a code watch", () => {
  async function watched(answer: () => Promise<"reload" | "keep">) {
    const { root, file } = await project();
    const clock = fakeClock();
    const events = fakeWatch();
    const changes: CodeChange[] = [];
    const watch = new CodeWatch({
      roots: [{ label: "pkg", path: root }],
      quietMs: 100,
      pollMs: 10_000,
      clock,
      watch: events.watch,
      onChange: async (change) => {
        changes.push(change);
        return answer();
      },
    });
    watch.start();
    return { file, clock, events, changes, watch };
  }

  /** Lets the check that a fired timer started finish. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };

  test("acts once, a quiet period after the last event", async () => {
    const w = await watched(async () => "keep");
    writeFileSync(w.file, "export const a = 2;\n");
    w.events.fire();
    w.clock.advance(60);
    w.events.fire();
    w.clock.advance(60);
    await settle();
    expect(w.changes).toHaveLength(0);
    w.clock.advance(40);
    await settle();
    expect(w.changes).toHaveLength(1);
    w.watch.stop();
  });

  test("an event with no change in the files does nothing", async () => {
    const w = await watched(async () => "keep");
    writeFileSync(w.file, "export const a = 1;\n");
    w.events.fire();
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(0);
    w.watch.stop();
  });

  test("a kept change is not offered again until the files change again", async () => {
    const w = await watched(async () => "keep");
    writeFileSync(w.file, "export const a = (;\n");
    w.events.fire();
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(1);

    w.events.fire();
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(1);

    writeFileSync(w.file, "export const a = 3;\n");
    w.events.fire();
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(2);
    w.watch.stop();
  });

  test("a reload ends the watch; a change during the answer does nothing more", async () => {
    let release: (() => void) | undefined;
    const w = await watched(
      () =>
        new Promise((resolve) => {
          release = () => resolve("reload");
        }),
    );
    writeFileSync(w.file, "export const a = 2;\n");
    w.events.fire();
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(1);

    writeFileSync(w.file, "export const a = 3;\n");
    w.events.fire();
    // Only the fallback timer is set: the event did not start a quiet period.
    expect(w.clock.pending).toBe(1);
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(1);

    release?.();
    await settle();
    expect(w.events.open()).toBe(0);
    expect(w.clock.pending).toBe(0);
    w.events.fire();
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(1);
  });

  test("a stopped watch ignores events and leaves no timers", async () => {
    const w = await watched(async () => "keep");
    w.watch.stop();
    writeFileSync(w.file, "export const a = 2;\n");
    w.events.fire();
    expect(w.clock.pending).toBe(0);
    w.clock.advance(20_000);
    await settle();
    expect(w.changes).toHaveLength(0);
    expect(w.events.open()).toBe(0);
  });

  test("the timer finds a change no event reported", async () => {
    const w = await watched(async () => "keep");
    writeFileSync(w.file, "export const a = 2;\n");
    w.clock.advance(10_000);
    w.clock.advance(100);
    await settle();
    expect(w.changes).toHaveLength(1);
    w.watch.stop();
  });

  test("a settings file changing after a kept change is offered again", async () => {
    const { root, file } = await project();
    const settings = join(root, "settings.json");
    writeFileSync(settings, "{ broken");
    const clock = fakeClock();
    const events = fakeWatch();
    const changes: CodeChange[] = [];
    const watch = new CodeWatch({
      roots: [{ label: "pkg", path: join(root, "src") }],
      alsoWatch: [{ label: "settings", path: settings }],
      quietMs: 100,
      pollMs: 10_000,
      clock,
      watch: events.watch,
      onChange: async (change) => {
        changes.push(change);
        return "keep";
      },
    });
    watch.start();
    writeFileSync(file, "export const a = 2;\n");
    events.fire();
    clock.advance(100);
    await settle();
    expect(changes).toHaveLength(1);

    writeFileSync(settings, "{}");
    events.fire();
    clock.advance(100);
    await settle();
    expect(changes).toHaveLength(2);
    watch.stop();
  });
});

describe("waiting for code to change", () => {
  test("resolves when an event shows a different file, and closes its handles", async () => {
    const { root, file } = await project();
    const roots = [{ label: "pkg", path: root }];
    const clock = fakeClock();
    const events = fakeWatch();
    const since = fingerprintCode(roots);
    const waiting = waitForCodeChange({ roots, since, pollMs: 1_000, clock, watch: events.watch });
    events.fire();
    expect(clock.pending).toBe(1);
    writeFileSync(file, "export const a = 2;\n");
    events.fire();
    const found = await waiting;
    expect(diffFingerprints(since, found)?.files).toEqual([file]);
    expect(events.open()).toBe(0);
    expect(clock.pending).toBe(0);
  });
});
