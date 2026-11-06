import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  LockHeldError,
  Runner,
  StateError,
  defaultOperadHome,
  ensureConfig,
  formatHistoryEntry,
  historyEntries,
  listPending,
  listRunning,
  loadPluginRegistry,
  openConfigLog,
  parseObjectKey,
  readConfig,
  serve,
  storeRootOf,
  ENGINE_VERSION,
  FilePluginStore,
  type LogBackend,
  type OperadConfig,
  type PluginRegistry,
  type RunInfo,
} from "@operad-io/engine";

/** Where a command writes. Tests pass a collector instead of the process. */
export interface CliIo {
  write(text: string): void;
  error(text: string): void;
}

const STDIO: CliIo = {
  write: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
};

/** A command line mistake; exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface MainOptions {
  /** The operad home; defaults to `$OPERAD_HOME` or `~/.operad`. */
  readonly home?: string | undefined;
  readonly io?: CliIo | undefined;
}

const KERNEL_VERBS = [
  "init",
  "serve",
  "pending",
  "history",
  "running",
  "flows",
  "run-internal",
] as const;

const HELP = [
  "usage: operad <command> [options]",
  "",
  "  init                 create the operad home and check the plugins",
  "  serve                run the kernel loop for this home",
  "  pending [--json]     things waiting for a person",
  "  history <id> [--json] steps of a run, or of a plugin object's runs",
  "  running              runs in progress",
  "  flows                loaded flows and where they come from",
  "  <plugin> <verb>      a verb a loaded plugin declares",
  "",
].join("\n");

interface Context {
  readonly home: string;
  readonly config: OperadConfig;
  readonly registry: PluginRegistry;
  readonly log: LogBackend;
  readonly storeRoot: string;
}

async function openContext(home: string, io: CliIo): Promise<Context> {
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store = new FilePluginStore({ root: join(storeRoot, "plugins") });
  const registry = await loadPluginRegistry({
    home,
    cwd: home,
    store,
    kernelVerbs: KERNEL_VERBS,
    onLog: (message) => io.error(`${message}\n`),
  });
  return {
    home,
    config,
    registry,
    log: openConfigLog(config),
    storeRoot,
  };
}

function splitFlag(
  argv: readonly string[],
  flag: string,
): { readonly args: string[]; readonly present: boolean } {
  const args: string[] = [];
  let present = false;
  for (const arg of argv) {
    if (arg === flag) present = true;
    else args.push(arg);
  }
  return { args, present };
}

function seconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const whole = Math.floor(ms / 1000);
  if (whole < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}m ${rest}s`;
}

function printValue(io: CliIo, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    io.write(`${value}\n`);
    return;
  }
  io.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandInit(home: string, io: CliIo): Promise<number> {
  const ensured = await ensureConfig(home);
  io.write(
    `${ensured.created ? "created" : "using"} ${ensured.path}\n`,
  );
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const registry = await loadPluginRegistry({
    home,
    cwd: home,
    store: new FilePluginStore({ root: join(storeRoot, "plugins") }),
    kernelVerbs: KERNEL_VERBS,
    onLog: (message) => io.error(`${message}\n`),
  });

  const checks = await registry.checks();
  if (checks.length === 0) {
    io.write("no plugins loaded\n");
    return 0;
  }
  let failed = false;
  for (const check of checks) {
    if (!check.ok) failed = true;
    io.write(`${check.plugin}: ${check.message}\n`);
  }
  return failed ? 1 : 0;
}

async function commandPending(
  context: Context,
  io: CliIo,
  json: boolean,
): Promise<void> {
  const pending = await listPending(context.log, context.registry);
  if (json) {
    io.write(`${JSON.stringify(pending, null, 2)}\n`);
    return;
  }
  if (pending.length === 0) {
    io.write("nothing is waiting\n");
    return;
  }
  for (const item of pending) {
    io.write(`${item.runId}  ${item.flow}  ${item.step ?? "-"}\n`);
    io.write(`  waiting: ${item.prompt}\n`);
    if (item.choices.length > 0) {
      io.write(`  choices: ${item.choices.join(", ")}\n`);
    }
    if (item.actions.length > 0) {
      io.write(
        `  actions: ${item.actions
          .map((action) => `${action.plugin}/${action.action}`)
          .join(", ")}\n`,
      );
    }
  }
}

async function findHistoryRuns(
  log: LogBackend,
  id: string,
): Promise<readonly RunInfo[]> {
  const runs = await log.runs();
  const exact = runs.find((run) => run.runId === id);
  if (exact !== undefined) return [exact];
  return runs.filter(
    (run) => run.object === id || run.object.endsWith(`:${id}`),
  );
}

async function streamEntriesJson(
  log: LogBackend,
  runId: string,
  io: CliIo,
  indent: string,
): Promise<void> {
  let first = true;
  for await (const entry of historyEntries(log.read(runId))) {
    if (!first) io.write(",\n");
    first = false;
    io.write(
      `${indent}${JSON.stringify({
        time: new Date(entry.time).toISOString(),
        step: entry.step,
        what: entry.what,
        why: entry.why,
      })}`,
    );
  }
}

async function commandHistory(
  context: Context,
  io: CliIo,
  id: string,
  json: boolean,
): Promise<void> {
  const runs = await findHistoryRuns(context.log, id);
  if (runs.length === 0) {
    throw new Error(`no run or object "${id}"`);
  }
  const ordered = [...runs].sort(
    (left, right) => left.startedAt - right.startedAt,
  );

  if (json && ordered.length === 1) {
    const run = ordered[0];
    if (run === undefined) return;
    io.write("[\n");
    await streamEntriesJson(context.log, run.runId, io, "  ");
    io.write("\n]\n");
    return;
  }

  if (json) {
    io.write("[\n");
    for (const [index, run] of ordered.entries()) {
      if (index > 0) io.write(",\n");
      io.write(
        `${JSON.stringify({ id: run.runId, flow: run.flow }).slice(0, -1)},"entries":[\n`,
      );
      await streamEntriesJson(context.log, run.runId, io, "    ");
      io.write("\n  ]}");
    }
    io.write("\n]\n");
    return;
  }

  for (const [index, run] of ordered.entries()) {
    if (index > 0) io.write("\n");
    if (ordered.length > 1) {
      io.write(`run ${run.runId} (${run.flow})\n`);
    }
    for await (const entry of historyEntries(context.log.read(run.runId))) {
      io.write(`${formatHistoryEntry(entry)}\n`);
    }
  }
}

async function commandRunning(
  context: Context,
  io: CliIo,
  json: boolean,
): Promise<void> {
  const running = await listRunning(context.log);
  if (json) {
    io.write(`${JSON.stringify(running, null, 2)}\n`);
    return;
  }
  if (running.length === 0) {
    io.write("nothing is running\n");
    return;
  }
  for (const item of running) {
    io.write(
      `${item.runId}  ${item.flow}  ${item.step ?? "-"}  ${seconds(item.elapsedMs)}\n`,
    );
  }
}

function commandFlows(context: Context, io: CliIo, json: boolean): void {
  const flows = context.registry.flows();
  if (json) {
    io.write(
      `${JSON.stringify(
        flows.map((entry) => ({
          name: entry.flow.name,
          plugin: entry.plugin,
          source: entry.source ?? null,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (flows.length === 0) {
    io.write("no flows loaded\n");
    return;
  }
  for (const entry of flows) {
    const source =
      entry.source === undefined || entry.source === entry.plugin
        ? ""
        : `  (${entry.source})`;
    io.write(`${entry.flow.name}  ${entry.plugin}${source}\n`);
  }
}

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));

function spawnChild(
  home: string,
  storeRoot: string,
): (runId: string, options: { readonly recover: boolean }) => void {
  return (runId, options) => {
    const directory = join(storeRoot, "logs", "runs");
    mkdirSync(directory, { recursive: true });
    const output = join(directory, `${runId}.out`);
    const fd = openSync(output, "a");
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          CLI_ENTRY,
          "run-internal",
          runId,
          ...(options.recover ? ["--recover"] : []),
        ],
        cwd: home,
        env: { ...process.env, OPERAD_HOME: home },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
  };
}

async function commandServe(
  context: Context,
  io: CliIo,
  argv: readonly string[],
): Promise<void> {
  const interval = process.env.OPERAD_SERVE_INTERVAL_MS;
  const parsed = interval === undefined ? Number.NaN : Number(interval);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    io.write(`serving ${context.home}\n`);
    await serve({
      home: context.home,
      log: context.log,
      registry: context.registry,
      lockRoot: context.storeRoot,
      spawnRun: spawnChild(context.home, context.storeRoot),
      intervalMs: Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000,
      signal: controller.signal,
      clock: () => Date.now(),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function commandRunInternal(
  context: Context,
  argv: readonly string[],
): Promise<void> {
  const { args, present } = splitFlag(argv, "--recover");
  const runId = args[0];
  if (runId === undefined) throw new UsageError("run-internal needs a run id");

  const runs = await context.log.runs();
  const run = runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) throw new Error(`no run "${runId}"`);
  const found = context.registry.flow(run.flow);
  if (found === undefined) {
    throw new StateError(`run "${runId}": flow "${run.flow}" is not loaded`);
  }
  const object = parseObjectKey(run.object);
  const runner = new Runner({
    log: context.log,
    flow: found.flow,
    runId,
    registry: context.registry,
    lockRoot: context.storeRoot,
    recover: present,
    ...(object === undefined ? {} : { object }),
  });
  await runner.run();
}

async function commandPlugin(
  context: Context,
  io: CliIo,
  argv: readonly string[],
): Promise<boolean> {
  const run = await context.registry.runCommand(argv, {
    cwd: context.home,
  });
  if (run === undefined) return false;
  printValue(io, run.value);
  return true;
}

/**
 * The `operad` command. Returns the exit code; the caller sets it and exits.
 * 0 ok, 1 error, 2 usage, 3 state does not allow it, 4 a lock is held.
 */
export async function main(
  args: readonly string[],
  options: MainOptions = {},
): Promise<number> {
  const io = options.io ?? STDIO;
  const home = options.home ?? defaultOperadHome();
  const command = args[0];

  try {
    if (command === "--version" || command === "-V") {
      io.write(`operad ${ENGINE_VERSION}\n`);
      return 0;
    }
    if (command === undefined || command === "help" || command === "--help") {
      io.write(HELP);
      return command === undefined ? 2 : 0;
    }

    if (command === "init") {
      return await commandInit(home, io);
    }

    if (command === "run-internal") {
      const context = await openContext(home, io);
      try {
        await commandRunInternal(context, args.slice(1));
      } finally {
        await context.log.close();
      }
      return 0;
    }

    if (command === "serve") {
      const context = await openContext(home, io);
      try {
        await commandServe(context, io, args.slice(1));
      } finally {
        await context.log.close();
      }
      return 0;
    }

    if (
      command === "pending" ||
      command === "history" ||
      command === "running" ||
      command === "flows"
    ) {
      const context = await openContext(home, io);
      try {
        if (command === "pending") {
          const { args: rest, present } = splitFlag(args.slice(1), "--json");
          if (rest.length > 0) {
            throw new UsageError("pending takes no arguments");
          }
          await commandPending(context, io, present);
          return 0;
        }
        if (command === "history") {
          const { args: rest, present } = splitFlag(args.slice(1), "--json");
          const id = rest[0];
          if (id === undefined) throw new UsageError("history needs a run id");
          if (rest.length > 1) throw new UsageError("history takes one id");
          await commandHistory(context, io, id, present);
          return 0;
        }
        if (command === "running") {
          const { args: rest, present } = splitFlag(args.slice(1), "--json");
          if (rest.length > 0) {
            throw new UsageError("running takes no arguments");
          }
          await commandRunning(context, io, present);
          return 0;
        }
        const { args: rest, present } = splitFlag(args.slice(1), "--json");
        if (rest.length > 0) throw new UsageError("flows takes no arguments");
        commandFlows(context, io, present);
        return 0;
      } finally {
        await context.log.close();
      }
    }

    const context = await openContext(home, io);
    try {
      if (await commandPlugin(context, io, args)) return 0;
    } finally {
      await context.log.close();
    }
    throw new UsageError(`unknown command "${command ?? ""}"`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`operad: ${error.message}\n\n${HELP}`);
      return 2;
    }
    if (error instanceof LockHeldError) {
      io.error(`operad: ${error.message}\n`);
      return 4;
    }
    if (error instanceof StateError) {
      io.error(`operad: ${error.message}\n`);
      return 3;
    }
    if (error instanceof ConfigError) {
      io.error(`operad: ${error.message}\n`);
      return 1;
    }
    io.error(
      `operad: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
