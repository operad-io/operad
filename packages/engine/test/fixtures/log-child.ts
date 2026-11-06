#!/usr/bin/env bun
/**
 * A child process for the log conformance suite. It is not a test file; the
 * suite spawns it so SIGKILL and cross-process races test real processes.
 */
import { randomUUID } from "node:crypto";
import type { LogBackend, LogBackendFactory } from "../../src/index.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) fail(`missing ${name}`);
  return value;
}

function isFactory(value: unknown): value is LogBackendFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof (value as { open?: unknown }).open === "function"
  );
}

async function loadFactory(): Promise<LogBackendFactory> {
  const modulePath = env("OPERAD_LOG_BACKEND_MODULE");
  const loaded: unknown = await import(modulePath);
  const candidate =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? (loaded as { default?: unknown }).default
      : undefined;
  if (!isFactory(candidate)) fail(`backend module ${modulePath} has no default factory`);
  return candidate;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openBackend(factory: LogBackendFactory, directory: string): Promise<LogBackend> {
  return await factory.open(directory);
}

async function startRace(): Promise<void> {
  const backend = await openBackend(await loadFactory(), env("OPERAD_LOG_STORE"));
  try {
    const run = await backend.startRun(env("OPERAD_FLOW"), env("OPERAD_OBJECT"));
    print({ ok: true, runId: run.runId });
  } catch (error) {
    print({ ok: false, name: errorName(error), message: errorMessage(error) });
  } finally {
    await backend.close();
  }
}

async function appendOnce(): Promise<void> {
  const backend = await openBackend(await loadFactory(), env("OPERAD_LOG_STORE"));
  try {
    const result = await backend.append(env("OPERAD_RUN_ID"), Number(env("OPERAD_EXPECTED_SEQ")), [
      {
        kind: "race",
        payload: { who: env("OPERAD_WHO") },
        cause: 1,
      },
    ]);
    print({ ok: true, lastSeq: result.lastSeq });
  } catch (error) {
    print({ ok: false, name: errorName(error), message: errorMessage(error) });
  } finally {
    await backend.close();
  }
}

async function appendLoop(): Promise<void> {
  const backend = await openBackend(await loadFactory(), env("OPERAD_LOG_STORE"));
  const runId = env("OPERAD_RUN_ID");

  let seq = 0;
  for await (const fact of backend.read(runId)) {
    seq = fact.seq;
  }

  // The parent SIGKILLs this process. A batch is small enough that the kill
  // sometimes lands in the middle of the next append.
  while (true) {
    const token = randomUUID();
    const count = 1 + Math.floor(Math.random() * 5);
    const facts = Array.from({ length: count }, (_, index) => ({
      kind: "crash",
      payload: { token, index, count },
      cause: 1,
    }));
    const result = await backend.append(runId, seq, facts);
    seq = result.lastSeq;
    process.stdout.write(`batch ${seq}\n`);
  }
}

const mode = process.argv[2];
if (mode === "start-race") {
  await startRace();
} else if (mode === "append-once") {
  await appendOnce();
} else if (mode === "append-loop") {
  await appendLoop();
} else {
  fail(`unknown mode ${String(mode)}`);
}
