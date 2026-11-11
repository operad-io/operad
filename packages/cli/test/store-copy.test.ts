import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  copyStore,
  LockHeldError,
  Runner,
  acquireLock,
  answerRun,
  loadPluginRegistry,
  openConfigLog,
  openLog,
  openPluginStore,
  readConfig,
  runLockPath,
  serveLockPath,
  storeMoveLockPath,
  storeRootOf,
  type LogBackend,
} from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/runner.ts", import.meta.url),
);

const cardsPath = fileURLToPath(new URL("./fixtures/cards-plugin.ts", import.meta.url));

interface Output {
  readonly io: CliIo;
  text(): string;
  errors(): string;
}

function capture(): Output {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

async function run(home: string, args: readonly string[]): Promise<{
  readonly code: number;
  readonly out: string;
  readonly err: string;
}> {
  const output = capture();
  const code = await main(args, { home, io: output.io });
  return { code, out: output.text(), err: output.errors() };
}

/** A home whose store is jsonl, with a finished run, a waiting run and a failed run. */
async function seededHome(): Promise<{
  readonly home: string;
  readonly root: string;
  readonly runs: { readonly finished: string; readonly waiting: string; readonly failed: string };
}> {
  const base = await tempRoot();
  const home = join(base, "home");
  const root = join(base, "store");
  mkdirSync(home, { recursive: true });
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({ plugins: [pluginPath, cardsPath], store: { backend: "jsonl", path: root } }),
  );

  // Everything the seeding stores takes its time from this clock, so the
  // stored times are the same on every run.
  let now = 1_700_000_000_000;
  const clock = (): number => {
    now += 1000;
    return now;
  };
  const objects = new FilePluginStore({ root: join(root, "plugins"), clock });
  objects.put("card", "1", { title: "Fix the gate" }, "seed");
  objects.put("card", "1", { title: "Fix the gate", state: "second" }, "seed");
  objects.put("card", "2", { title: "Review it" }, "seed");
  objects.put("card", "3", { title: "Break it" }, "seed");
  objects.append({ type: "note", data: { text: "kept" }, cause: "seed" });
  objects.append({ type: "note", object: { type: "card", id: "2" }, data: { text: "about 2" }, cause: "seed" });

  const config = await readConfig(home);
  const start = async (flowName: string, object: string): Promise<string> => {
    const log = openLog({ backend: "jsonl", path: root, clock });
    try {
      const registry = await loadPluginRegistry({ home, store: objects });
      const found = registry.flow(flowName);
      if (found === undefined) throw new Error(`missing flow ${flowName}`);
      const info = await log.startRun(flowName, object);
      await new Runner({ log, flow: found.flow, runId: info.runId, registry, lockRoot: root, clock }).run();
      return info.runId;
    } finally {
      await log.close();
    }
  };
  const finished = await start("simple", "card:1");
  // The same flow and object ran before: that run was answered and ended, and
  // the one now waiting started after it.
  const answered = await start("ask", "card:2");
  const answering = openLog({ backend: "jsonl", path: root, clock });
  const registry = await loadPluginRegistry({ home, store: objects });
  const ask = registry.flow("ask");
  if (ask === undefined) throw new Error("missing flow ask");
  await answerRun({
    log: answering,
    flow: ask.flow,
    runId: answered,
    choice: "finish",
    actor: { via: "test", id: "tester" },
    clock,
  });
  await answering.close();
  const waiting = await start("ask", "card:2");
  const failed = await start("throwing", "card:3");

  const log = openLog({ backend: "jsonl", path: root, clock });
  await log.appendGlobal({ kind: "seen", payload: { n: 1 }, cause: 1 }, "key-one");
  await log.appendGlobal({ kind: "seen", payload: { n: 2 }, cause: 1 });
  await log.recordInput(null, "test", "event-1", { hello: "world" });
  const input = await log.recordInput(waiting, "test", "event-2", { answer: "later" });
  await log.recordOutcome(input.inputId, "started", { run: waiting });
  await log.close();
  return { home, root, runs: { finished, waiting, failed } };
}

/** What every view answers for the seeded home. */
async function views(home: string, ids: readonly string[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  const ask = async (name: string, args: readonly string[]): Promise<void> => {
    const result = await run(home, args);
    expect([args.join(" "), result.code, result.err]).toEqual([args.join(" "), 0, ""]);
    answers[name] = result.out;
  };
  await ask("list card", ["list", "card", "--json"]);
  await ask("pending", ["pending", "--json"]);
  await ask("running", ["running", "--json"]);
  for (const object of ["card:1", "card:2", "card:3"]) {
    await ask(`show ${object}`, ["show", object, "--json"]);
  }
  for (const object of ["card:1", "card:2", "card:3"]) {
    await ask(`history ${object}`, ["history", object, "--json"]);
  }
  for (const id of ids) await ask(`history ${id}`, ["history", id, "--json"]);
  return answers;
}

async function everything(log: LogBackend) {
  const runs = (await log.runs()).sort((a, b) => (a.runId < b.runId ? -1 : 1));
  const facts: Record<string, unknown[]> = {};
  for (const info of runs) {
    facts[info.runId] = [];
    for await (const fact of log.read(info.runId)) facts[info.runId]?.push(fact);
  }
  const global = [];
  for await (const fact of log.readGlobal()) global.push(fact);
  const inputs = [];
  for await (const input of log.readInputs()) inputs.push(input);
  inputs.sort((a, b) => (a.inputId < b.inputId ? -1 : 1));
  const outcomes = [];
  for await (const outcome of log.readOutcomes()) outcomes.push(outcome);
  return { runs, facts, global, inputs, outcomes };
}

/** Every file below a directory with its size, for "nothing changed" checks. */
function snapshot(directory: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      Object.assign(result, snapshot(path, `${prefix}${name}/`));
    } else {
      result[`${prefix}${name}`] = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return result;
}

describe("store copy", () => {
  test("a store with a finished, a waiting and a failed run answers the same from its copy", async () => {
    const { home, root, runs } = await seededHome();
    const ids = [runs.finished, runs.waiting, runs.failed];
    const before = await views(home, ids);
    // The run states differ, so the views have something to tell apart.
    expect(before["pending"]).toContain(runs.waiting);
    expect(before["history card:1"]).not.toBe(before["history card:2"]);
    expect(before["history card:3"]).not.toBe(before["history card:1"]);
    const original = snapshot(root);
    // A writer killed mid-line leaves a torn last line on a run.
    appendFileSync(join(root, "runs", `${runs.waiting}.jsonl`), '{"type":"batch","facts":[{"runId":"x');

    const copied = await run(home, ["store", "copy", "sqlite"]);
    expect(copied.err).toBe("");
    expect(copied.code).toBe(0);
    expect(copied.out).toContain("copied the jsonl store to sqlite");

    // The source keeps every file it had, and the torn tail too: the copy
    // repaired a snapshot, not the source.
    const after = snapshot(root);
    const tornFile = `runs/${runs.waiting}.jsonl`;
    for (const [file, hash] of Object.entries(original)) {
      if (file === tornFile) expect(after[file]).not.toBe(hash);
      else expect(after[file]).toBe(hash);
    }
    expect(readFileSync(join(root, tornFile), "utf8").endsWith('{"runId":"x')).toBe(true);
    expect(existsSync(join(root, ".copying-source"))).toBe(false);
    expect(Object.keys(after).filter((file) => !(file in original)).sort()).toEqual([
      ".store-copy.json",
      "log.sqlite",
      "plugins.sqlite",
    ]);

    // Until the setting changes, nothing answers differently.
    expect(await views(home, ids)).toEqual(before);

    const used = await run(home, ["store", "use", "sqlite"]);
    expect(used.code).toBe(0);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      plugins: unknown;
      store: { backend: string; path: string };
    };
    expect(config.store).toEqual({ backend: "sqlite", path: join(root, "log.sqlite") });
    expect(config.plugins).toEqual([pluginPath, cardsPath]);

    expect(await views(home, ids)).toEqual(before);

    // The plugin objects and their facts are the same, version for version.
    const sqlite = openPluginStore({ backend: "sqlite", root });
    const jsonl = openPluginStore({ backend: "jsonl", root });
    try {
      expect(sqlite.facts()).toEqual(jsonl.facts());
      expect(sqlite.get("card", "1")).toEqual(jsonl.get("card", "1"));
      expect(sqlite.get("card", "1")?.version).toBe(2);
      expect(sqlite.list("card")).toEqual(jsonl.list("card"));
    } finally {
      (sqlite as unknown as { close(): void }).close();
    }

    // Switching back is changing the setting back.
    const back = await run(home, ["store", "use", "jsonl"]);
    expect(back.code).toBe(0);
    expect(await views(home, ids)).toEqual(before);
  });

  test("jsonl to sqlite to jsonl gives equal facts", async () => {
    const { home, root } = await seededHome();
    const first = openLog({ backend: "jsonl", path: root });
    const original = await everything(first);
    const originalObjects = openPluginStore({ backend: "jsonl", root }).facts();
    await first.close();
    expect(original.runs).toHaveLength(4);
    expect(original.global.map((fact) => fact.uniqueKey)).toEqual(["key-one", undefined]);

    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    expect((await run(home, ["store", "use", "sqlite"])).code).toBe(0);

    const sqlite = openLog({ backend: "sqlite", path: join(root, "log.sqlite") });
    const middle = await everything(sqlite);
    await sqlite.close();
    expect(middle).toEqual(original);

    // Move the first jsonl store aside so the way back has room.
    const aside = join(root, "..", "aside");
    mkdirSync(join(aside, "plugins"), { recursive: true });
    for (const name of ["runs", "inputs.jsonl", "outcomes.jsonl", "global-facts.jsonl", "schema.json", ".lock"]) {
      renameSync(join(root, name), join(aside, name));
    }
    renameSync(join(root, "plugins", "facts.jsonl"), join(aside, "plugins", "facts.jsonl"));

    const copied = await run(home, ["store", "copy", "jsonl"]);
    expect({ code: copied.code, err: copied.err }).toEqual({ code: 0, err: "" });
    expect((await run(home, ["store", "use", "jsonl"])).code).toBe(0);

    const second = openLog({ backend: "jsonl", path: root });
    expect(await everything(second)).toEqual(original);
    await second.close();
    expect(openPluginStore({ backend: "jsonl", root }).facts()).toEqual(originalObjects);

    // A stored unique key still holds after the round trip.
    const again = openConfigLog(await readConfig(home));
    const repeated = await again.appendGlobal({ kind: "other", payload: {}, cause: 1 }, "key-one");
    expect(repeated.kind).toBe("seen");
    await again.close();
  });

  test("it refuses while serve or a run has the store open, and writes nothing", async () => {
    const { home, root, runs } = await seededHome();
    const original = snapshot(root);

    const serve = acquireLock(serveLockPath(home));
    try {
      const refused = await run(home, ["store", "copy", "sqlite"]);
      expect(refused.code).toBe(4);
      expect(refused.err).toContain("serve.lock");
    } finally {
      serve.release();
    }

    const running = acquireLock(runLockPath(root, runs.waiting));
    try {
      const refused = await run(home, ["store", "copy", "sqlite"]);
      expect(refused.code).toBe(3);
      expect(refused.err).toContain(runs.waiting);
    } finally {
      running.release();
    }

    expect(snapshot(root)).toEqual(original);
    expect(existsSync(join(root, "log.sqlite"))).toBe(false);
    expect(existsSync(serveLockPath(home))).toBe(false);
  });

  test("copy and use change nothing under the source directory", async () => {
    const { home, root, runs } = await seededHome();
    // No plugins directory, a stale lock of a dead process, a torn last line
    // and an older schema marker: each is something opening a store repairs.
    rmSync(join(root, "plugins"), { recursive: true, force: true });
    const dead = Bun.spawnSync({ cmd: ["true"] }).pid;
    mkdirSync(join(root, "locks", "runs"), { recursive: true });
    writeFileSync(join(root, "locks", "runs", "gone.lock"), `${JSON.stringify({ pid: dead, at: 1 })}\n`);
    appendFileSync(join(root, "runs", `${runs.waiting}.jsonl`), '{"type":"batch","facts":[{"runId":"x');
    writeFileSync(join(root, "schema.json"), '{"schema_version":1}\n');

    // Every path with its kind, size, mode and content hash, directories too.
    const tree = (directory: string, prefix = ""): Record<string, string> => {
      const result: Record<string, string> = {};
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const info = statSync(path);
        const key = `${prefix}${name}`;
        if (info.isDirectory()) {
          result[`${key}/`] = `dir ${info.mode}`;
          Object.assign(result, tree(path, `${key}/`));
        } else {
          const hash = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
          result[key] = `file ${info.size} ${info.mode} ${hash}`;
        }
      }
      return result;
    };
    const before = tree(root);
    const unchanged = (): void => {
      const after = tree(root);
      for (const [path, what] of Object.entries(before)) expect([path, after[path]]).toEqual([path, what]);
      expect(Object.keys(after).filter((path) => !(path in before)).sort()).toEqual([
        ".store-copy.json",
        "log.sqlite",
        "plugins.sqlite",
      ]);
    };

    const copied = await run(home, ["store", "copy", "sqlite"]);
    expect([copied.code, copied.err]).toEqual([0, ""]);
    unchanged();
    expect((await run(home, ["store", "use", "sqlite"])).code).toBe(0);
    unchanged();
    expect((await run(home, ["store", "use", "jsonl"])).code).toBe(0);
    unchanged();
  });

  test("a run that starts while the store is being copied is refused", async () => {
    const { home, root } = await seededHome();
    const config = await readConfig(home);
    const objects = new FilePluginStore({ root: join(root, "plugins") });
    const registry = await loadPluginRegistry({ home, store: objects });
    const found = registry.flow("simple");
    if (found === undefined) throw new Error("missing flow simple");
    const log = openConfigLog(config);
    try {
      const info = await log.startRun("simple", "card:9");
      const runner = new Runner({ log, flow: found.flow, runId: info.runId, registry, lockRoot: root });
      // What a copy holds from before it looks at the run locks until it ends.
      const moving = acquireLock(storeMoveLockPath(root));
      try {
        await expect(runner.run()).rejects.toBeInstanceOf(LockHeldError);
        expect(existsSync(runLockPath(root, info.runId))).toBe(false);
      } finally {
        moving.release();
      }
      expect(await runner.run()).toBe("ended");
    } finally {
      await log.close();
    }
  });

  test("a copy of a store with no locks directory leaves none behind", async () => {
    const { home, root } = await seededHome();
    rmSync(join(root, "locks"), { recursive: true, force: true });
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    expect(existsSync(join(root, "locks"))).toBe(false);
  });

  test("an answer or a plugin write while the store is being moved is refused", async () => {
    const { home, root, runs } = await seededHome();
    const moving = acquireLock(storeMoveLockPath(root));
    try {
      const answered = await run(home, ["cards:approve", "card:2"]);
      expect(answered.code).toBe(4);
      expect(answered.err).toContain("store move is in progress");
      const objects = new FilePluginStore({ root: join(root, "plugins") });
      expect(() => objects.put("card", "9", { title: "late" }, "late")).toThrow(
        "store move is in progress",
      );
      const log = openConfigLog(await readConfig(home));
      try {
        await expect(log.appendGlobal({ kind: "late", payload: {}, cause: 1 })).rejects.toThrow(
          "store move is in progress",
        );
        // Reading is not refused.
        expect((await log.runs()).some((info) => info.runId === runs.waiting)).toBe(true);
      } finally {
        await log.close();
      }
    } finally {
      moving.release();
    }
    // Once the move is over the same answer goes through.
    expect((await run(home, ["cards:approve", "card:2"])).code).toBe(0);
  });

  test("a write that reaches the source after it was read makes the copy fail and leaves no target", async () => {
    const { home, root } = await seededHome();
    const config = await readConfig(home);
    await expect(
      copyStore({
        home,
        config,
        to: "sqlite",
        afterSnapshot: () => {
          // A writer that began before the copy took its lock: raw bytes, no checks.
          appendFileSync(
            join(root, "plugins", "facts.jsonl"),
            `${JSON.stringify({ sequence: 99, type: "note", cause: "late", at: 1, data: {} })}\n`,
          );
        },
      }),
    ).rejects.toThrow("changed while it was being copied");
    expect(existsSync(join(root, "log.sqlite"))).toBe(false);
    expect(existsSync(join(root, "plugins.sqlite"))).toBe(false);
    expect(existsSync(join(root, ".copying-source"))).toBe(false);
    expect(existsSync(join(root, "locks", "store-move.lock"))).toBe(false);
  });

  test("a plugin write under way when the copy starts is in the copy", async () => {
    const { home, root } = await seededHome();
    const child = Bun.spawn({
      cmd: [process.execPath, fileURLToPath(new URL("./fixtures/hold-facts-lock.ts", import.meta.url)), root],
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    const before = new FilePluginStore({ root: join(root, "plugins") }).facts().length;
    // The copy waits for the writer's lock, so it sees the writer's fact.
    const copied = await run(home, ["store", "copy", "sqlite"]);
    expect([copied.code, copied.err]).toEqual([0, ""]);
    await child.exited;
    const sqlite = openPluginStore({ backend: "sqlite", root });
    try {
      expect(sqlite.facts()).toHaveLength(before + 1);
      expect(sqlite.facts().some((fact) => fact.cause === "slow")).toBe(true);
    } finally {
      (sqlite as unknown as { close(): void }).close();
    }
  });

  test("a sqlite store refuses writes while a move holds it", async () => {
    const { home, root } = await seededHome();
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    expect((await run(home, ["store", "use", "sqlite"])).code).toBe(0);
    const moving = acquireLock(storeMoveLockPath(root));
    try {
      const answered = await run(home, ["cards:approve", "card:2"]);
      expect(answered.code).toBe(4);
      expect(answered.err).toContain("store move is in progress");
      const log = openLog({ backend: "sqlite", path: join(root, "log.sqlite") });
      try {
        await expect(log.appendGlobal({ kind: "late", payload: {}, cause: 1 })).rejects.toThrow(
          "store move is in progress",
        );
      } finally {
        await log.close();
      }
      const objects = openPluginStore({ backend: "sqlite", root });
      try {
        expect(() => objects.put("card", "9", { title: "late" }, "late")).toThrow("store move is in progress");
        expect(objects.get("card", "9")).toBeUndefined();
      } finally {
        (objects as unknown as { close(): void }).close();
      }
    } finally {
      moving.release();
    }
  });

  test("use refuses a copy that is older than its source, and switching back is allowed", async () => {
    const { home, root } = await seededHome();
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    // Something is written to the store the copy was made from.
    new FilePluginStore({ root: join(root, "plugins") }).put("card", "7", { title: "after the copy" }, "later");
    const stale = await run(home, ["store", "use", "sqlite"]);
    expect(stale.code).toBe(3);
    expect(stale.err).toContain("changed after it was copied");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).store.backend).toBe("jsonl");
    expect(existsSync(join(root, ".copying-source"))).toBe(false);

    // Starting again from a clean target works, and going back needs no check.
    for (const name of ["log.sqlite", "plugins.sqlite"]) rmSync(join(root, name));
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    expect((await run(home, ["store", "use", "sqlite"])).code).toBe(0);
    expect((await run(home, ["store", "use", "jsonl"])).code).toBe(0);
  });

  test("use refuses while a run holds the store", async () => {
    const { home, root, runs } = await seededHome();
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    const running = acquireLock(runLockPath(root, runs.waiting));
    try {
      const refused = await run(home, ["store", "use", "sqlite"]);
      expect(refused.code).toBe(3);
      expect(refused.err).toContain(runs.waiting);
    } finally {
      running.release();
    }
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).store.backend).toBe("jsonl");
  });

  test("it refuses a target that already exists", async () => {
    const { home, root } = await seededHome();
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    const copy = snapshot(root);

    const again = await run(home, ["store", "copy", "sqlite"]);
    // The store already uses jsonl, so the target is sqlite and its file is there.
    expect(again.code).toBe(3);
    expect(again.err).toContain("log.sqlite already exists");
    expect(snapshot(root)).toEqual(copy);

    expect((await run(home, ["store", "use", "sqlite"])).code).toBe(0);
    const back = await run(home, ["store", "copy", "jsonl"]);
    expect(back.code).toBe(3);
    expect(back.err).toContain("already exists");
    expect(snapshot(root)).toEqual(copy);
  });

  test("a copy that fails leaves no store behind, and use needs a copy", async () => {
    const { home, root } = await seededHome();
    const unused = await run(home, ["store", "use", "sqlite"]);
    expect(unused.code).toBe(3);
    expect(unused.err).toContain("copy it first");

    // A leftover of a killed copy is removed, not mistaken for a store.
    mkdirSync(join(root, ".copying-sqlite"));
    await Bun.write(join(root, ".copying-sqlite", "log.sqlite"), "partial");
    expect((await run(home, ["store", "copy", "sqlite"])).code).toBe(0);
    expect(existsSync(join(root, ".copying-sqlite"))).toBe(false);
    expect(storeRootOf(await readConfig(home))).toBe(root);
  });

  test("it explains itself without internal words", async () => {
    const { home } = await seededHome();
    const same = await run(home, ["store", "copy", "jsonl"]);
    expect(same.code).toBe(3);
    const usage = await run(home, ["store", "copy"]);
    expect(usage.code).toBe(2);
    const done = await run(home, ["store", "copy", "sqlite"]);
    for (const word of ["backend", "fact", "effect", "node", "graph", "decide"]) {
      expect((done.out + usage.err + same.err).toLowerCase()).not.toContain(word);
    }
  });
});
