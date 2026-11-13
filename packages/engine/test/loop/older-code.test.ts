import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  CodeWatch,
  listPending,
  MemoryPluginStore,
  olderCodeNotice,
  openLog,
  PluginRegistry,
  serveLockPath,
} from "../../src/index.ts";
import { fakeClock } from "../../src/testing/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

/** A home whose serve loaded `src/a.ts` (code) and ignores `notes/b.ts`. */
async function setup() {
  const home = await tempRoot();
  const code = join(home, "code");
  mkdirSync(join(code, "src"), { recursive: true });
  const loaded = join(code, "src", "a.ts");
  writeFileSync(loaded, "export const a = 1;\n");
  const elsewhere = join(home, "notes");
  mkdirSync(elsewhere, { recursive: true });
  const unloaded = join(elsewhere, "b.ts");
  writeFileSync(unloaded, "export const b = 1;\n");

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
  const clock = fakeClock();
  const listeners = new Set<(name: string | null) => void>();
  // The restart is deferred: the new code is not taken up.
  let answer: "reload" | "keep" = "keep";
  const watch = new CodeWatch({
    roots: [{ label: "code", path: code }],
    quietMs: 100,
    pollMs: 10_000,
    clock,
    watch: (_directory, onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    onOlder: notice.report,
    onChange: async () => answer,
  });
  watch.start();
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };
  const touch = async (): Promise<void> => {
    for (const listener of [...listeners]) listener(null);
    clock.advance(100);
    await settle();
  };
  const pending = async () => (await listPending(log, registry)).map((item) => item.prompt);
  return {
    loaded,
    unloaded,
    watch,
    touch,
    pending,
    lock,
    notice,
    setAnswer: (value: "reload" | "keep") => {
      answer = value;
    },
    close: async () => {
      watch.stop();
      lock.release();
      await log.close();
    },
  };
}

describe("serve runs older code than the files on disk", () => {
  test("a loaded file that changed while the restart is deferred shows one item, gone after the restart", async () => {
    const s = await setup();
    expect(await s.pending()).toEqual([]);
    writeFileSync(s.loaded, "export const a = (;\n");
    await s.touch();
    const shown = await s.pending();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("serve runs older code");
    expect(shown[0]).toContain("restart");
    // Another change while it is deferred is still one item.
    writeFileSync(s.loaded, "export const a = 3;\n");
    await s.touch();
    expect(await s.pending()).toHaveLength(1);
    // The restart: serve stops and a new serve clears the notice and holds the lock.
    s.watch.stop();
    s.notice.clear();
    expect(await s.pending()).toEqual([]);
    await s.close();
  });

  test("the item leaves when the file is back to what serve loaded", async () => {
    const s = await setup();
    writeFileSync(s.loaded, "export const a = 2;\n");
    await s.touch();
    expect(await s.pending()).toHaveLength(1);
    writeFileSync(s.loaded, "export const a = 1;\n");
    await s.touch();
    expect(await s.pending()).toEqual([]);
    await s.close();
  });

  test("a change to a file that is not loaded shows nothing", async () => {
    const s = await setup();
    writeFileSync(s.unloaded, "export const b = 2;\n");
    await s.touch();
    expect(await s.pending()).toEqual([]);
    await s.close();
  });

  test("a notice left by a serve that is no longer the lock holder shows nothing", async () => {
    const s = await setup();
    writeFileSync(s.loaded, "export const a = 2;\n");
    await s.touch();
    expect(await s.pending()).toHaveLength(1);
    // The notice names another live process; this one holds the lock.
    olderCodeNotice(join(s.lock.path, ".."), process.ppid).report(true);
    expect(await s.pending()).toEqual([]);
    await s.close();
  });
});
