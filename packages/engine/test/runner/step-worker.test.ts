import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPluginStore } from "../../src/index.ts";
import { waitForChange } from "../../src/platform/index.ts";
import {
  runStepWorker,
  startStepWorker,
  type StepWorkerPort,
  type StepWorkerRequest,
} from "../../src/runner/step-worker.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../fixtures/plugins/step-worker.ts", import.meta.url),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stands in for the run's process while the worker function runs in this one. */
class FakePort implements StepWorkerPort {
  private readonly sent: unknown[] = [];
  private readonly consumed = new Set<number>();
  private readonly listeners: ((message: unknown) => void)[] = [];
  private wake: (() => void) | undefined;

  on(_event: "message", listener: (message: unknown) => void): void {
    this.listeners.push(listener);
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  send(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  /** The next message of `kind` not taken before. */
  async next(kind: string): Promise<Record<string, unknown>> {
    for (;;) {
      const index = this.sent.findIndex(
        (message, at) =>
          !this.consumed.has(at) &&
          isRecord(message) &&
          message.kind === kind,
      );
      if (index >= 0) {
        this.consumed.add(index);
        const found = this.sent[index];
        if (!isRecord(found)) throw new Error(`the ${kind} message is not an object`);
        return found;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function request(
  root: string,
  use: string,
  params: unknown = {},
  extra: Partial<StepWorkerRequest> = {},
): StepWorkerRequest {
  return {
    sources: [pluginPath],
    home: root,
    cwd: root,
    storeRoot: join(root, "store"),
    use,
    params,
    flowParams: null,
    runId: "run-1",
    ...extra,
  };
}

async function resultOf(port: FakePort, run: Promise<void>): Promise<Record<string, unknown>> {
  const reply = await port.next("result");
  await run;
  return reply;
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), 200);
  }
}

describe("step worker in this process", () => {
  test("loads the plugin's file and answers the parent with the step's result", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/echo", { text: "hi" }), port);
    expect(await resultOf(port, run)).toMatchObject({
      kind: "result",
      ok: true,
      result: { result: "ok", data: { params: { text: "hi" } } },
    });
  });

  test("a worker step writes to the configured sqlite store", async () => {
    const root = await tempRoot();
    const sqlite = join(root, "sqlite");
    const port = new FakePort();
    const run = runStepWorker(
      request(root, "worker/write", {}, {
        store: { backend: "sqlite", root: sqlite, file: join(sqlite, "plugins.sqlite") },
      }),
      port,
    );
    expect(await resultOf(port, run)).toMatchObject({ ok: true });

    const configured = openPluginStore({ backend: "sqlite", root: sqlite });
    expect((await configured.get("thing", "1"))?.data.wrote).toBe(true);
    expect(existsSync(join(sqlite, "plugins.sqlite"))).toBe(true);
    expect(existsSync(join(sqlite, "facts.jsonl"))).toBe(false);
  });

  test("opens the run's store root or a configured JSONL store", async () => {
    const root = await tempRoot();
    const plain = join(root, "plain");
    const jsonl = join(root, "jsonl");

    const runs: readonly [string, Readonly<Record<string, unknown>>][] = [
      [plain, {}],
      [jsonl, { store: { backend: "jsonl", root: jsonl } }],
    ];
    for (const [requestRoot, extra] of runs) {
      const port = new FakePort();
      const run = runStepWorker(request(requestRoot, "worker/write", {}, extra), port);
      expect(await resultOf(port, run)).toMatchObject({ ok: true });
    }

    expect(existsSync(join(plain, "store", "facts.jsonl"))).toBe(true);
    expect(existsSync(join(jsonl, "facts.jsonl"))).toBe(true);
  });

  test("sends an emitted event and waits for the parent's answer", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/emit"), port);
    const emit = await port.next("emit");
    expect(emit).toMatchObject({
      kind: "emit",
      plugin: "worker",
      event: { type: "worker.event", data: { hello: "world" } },
    });
    port.send({ kind: "emit-result", id: emit.id, ok: true });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "ok" },
    });
  });

  test("a refused event fails the step with the parent's reason", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/emit"), port);
    const emit = await port.next("emit");
    port.send({ kind: "emit-result", id: emit.id, ok: false, error: "not now" });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "failed", data: { error: "not now" } },
    });
  });

  test("asks the parent and returns the answer to the step", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/ask"), port);
    const ask = await port.next("ask");
    expect(ask).toMatchObject({
      kind: "ask",
      request: { prompt: "Go?", choices: ["yes", "no"], graceSecs: 5 },
    });
    port.send({
      kind: "ask-result",
      id: ask.id,
      ok: true,
      outcome: { kind: "answered", answer: { choice: "yes" } },
    });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "answered", data: { choice: "yes" } },
    });
  });

  test("an aborted question tells the parent to cancel it and fails the step", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/ask"), port);
    const ask = await port.next("ask");
    port.send("abort");
    const cancel = await port.next("ask-cancel");
    expect(cancel.id).toBe(ask.id);
    port.send({
      kind: "ask-result",
      id: ask.id,
      ok: false,
      error: "the question was cancelled",
    });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "failed", data: { error: "the question was cancelled" } },
    });
  });

  test("uses a one-time grant through the parent", async () => {
    const root = await tempRoot();
    for (const used of [true, false]) {
      const port = new FakePort();
      const run = runStepWorker(request(root, "worker/grant"), port);
      const grant = await port.next("grant");
      expect(grant).toMatchObject({ kind: "grant", waitId: "w1" });
      port.send({ kind: "grant-result", id: grant.id, ok: true, used });
      expect(await resultOf(port, run)).toMatchObject({
        ok: true,
        result: { result: "ok", data: { used } },
      });
    }
  });

  test("a refused grant fails the step with the parent's reason", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/grant"), port);
    const grant = await port.next("grant");
    port.send({ kind: "grant-result", id: grant.id, ok: false, error: "no access" });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "failed", data: { error: "no access" } },
    });
  });

  test("reports a place it manages and releases it through the parent", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/report"), port);
    const report = await port.next("limit");
    expect(report).toMatchObject({
      kind: "limit",
      report: true,
      key: "place",
      ahead: 3,
    });
    port.send({ kind: "limit-result", id: report.id, ok: true });
    const release = await port.next("limit-release");
    expect(release.id).toBe(report.id);
    port.send({ kind: "limit-result", id: release.id, ok: true });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "ok" },
    });
  });

  test("a refused place fails the step with the parent's reason", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/report"), port);
    const report = await port.next("limit");
    port.send({ kind: "limit-result", id: report.id, ok: false, error: "full" });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "failed", data: { error: "full" } },
    });
  });

  test("acquires and releases a place for a nested step", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/outer"), port);
    const acquire = await port.next("limit");
    expect(acquire).toMatchObject({
      kind: "limit",
      use: "worker/hold",
      key: "key",
      concurrent: 1,
    });
    port.send({ kind: "limit-result", id: acquire.id, ok: true });
    const release = await port.next("limit-release");
    expect(release.id).toBe(acquire.id);
    port.send({ kind: "limit-result", id: release.id, ok: true });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "ok" },
    });
  });

  test("an aborted place tells the parent to cancel it and fails the step", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/outer"), port);
    const acquire = await port.next("limit");
    port.send("abort");
    const cancel = await port.next("limit-cancel");
    expect(cancel.id).toBe(acquire.id);
    port.send({
      kind: "limit-result",
      id: acquire.id,
      ok: false,
      error: "the place was cancelled",
    });
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "failed", data: { error: "the place was cancelled" } },
    });
  });

  test("stops the step when the parent aborts it", async () => {
    const root = await tempRoot();
    const marker = join(root, "step-worker-abort");
    const port = new FakePort();
    const run = runStepWorker(request(root, "worker/abort"), port);
    await waitForFile(marker);
    port.send("abort");
    expect(await resultOf(port, run)).toMatchObject({
      ok: true,
      result: { result: "ok", data: { aborted: true } },
    });
  });

  test("the process entry reports a failed step to the parent", async () => {
    const root = await tempRoot();
    const port = new FakePort();
    startStepWorker(request(root, "worker/missing"), port);
    expect(await port.next("result")).toMatchObject({
      kind: "result",
      ok: false,
      error: expect.stringContaining("worker/missing"),
    });
  });
});
