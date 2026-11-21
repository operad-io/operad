/**
 * bench-serve.ts: a repeatable load scenario for `operad serve`.
 *
 * It builds a synthetic home under a temp directory (never the real
 * `~/.operad`), starts the serve of the repository named by `--repo`, and
 * drives one fixed scenario for `--duration`:
 *
 * - three runs whose step logs grow every 50 ms, so the kernel announces each
 *   object at its 250 ms growth window;
 * - one chat-like object with a streaming reply, pushed every 50 ms;
 * - two runs waiting for a person, so pending has work;
 * - a terminal-like and a desktop-like client following `/v1/events` and
 *   reading pending and running, plus an independent pending/running probe.
 *
 * The script records serve CPU time and RSS, tail-event latency,
 * pending/running response times and request counts, and prints one JSON
 * object. `--repeat N` runs the same scenario N times. `--profile-dir DIR`
 * starts serve under `bun --cpu-prof` and adds the top self-time frames.
 *
 * Example:
 *   bun scripts/bench-serve.ts --repo . --label current --repeat 3 \
 *     --duration 20000 --out /tmp/serve-current.json
 *
 *   bun scripts/bench-serve.ts --repo /tmp/operad-before --label before \
 *     --repeat 3 --duration 20000 --out /tmp/serve-before.json
 *
 * The synthetic home is deliberate: it has the same kind of facts and objects
 * the real home has (active run facts, step logs that grow, waits, one chat
 * tail), but no repository, harness or network call. The same scenario runs on
 * old and current code.
 */

import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Options {
  readonly repo: string;
  readonly label: string;
  readonly durationMs: number;
  readonly warmupMs: number;
  readonly repeat: number;
  readonly out: string | undefined;
  readonly keep: boolean;
  readonly profileDir: string | undefined;
  readonly serveIntervalMs: number | undefined;
  readonly storeFrom: string | undefined;
}

function usage(): string {
  return [
    "usage: bun scripts/bench-serve.ts [options]",
    "  --repo <path>          repository to load serve from (default: cwd)",
    "  --label <name>         name for this measurement (default: repo name)",
    "  --duration <ms>        measured scenario time (default: 20000)",
    "  --warmup <ms>          extra settle time after readiness (default: 500)",
    "  --repeat <n>           run the scenario n times (default: 1)",
    "  --out <path>           write the JSON result to this file",
    "  --profile-dir <path>   profile serve with bun --cpu-prof",
    "  --serve-interval <ms>  set OPERAD_SERVE_INTERVAL_MS (default: serve's own)",
    "  --store-from <dir>     copy the sqlite stores from this home's store dir",
    "  --keep                 keep each temp home",
  ].join("\n");
}

function optionValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Options {
  let repo = process.cwd();
  let label: string | undefined;
  let durationMs = 20_000;
  let warmupMs = 500;
  let repeat = 1;
  let out: string | undefined;
  let keep = false;
  let profileDir: string | undefined;
  let serveIntervalMs: number | undefined;
  let storeFrom: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const [name, inline] = arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    const value = (): string =>
      inline ?? optionValue(argv, index, name);
    switch (name) {
      case "--repo":
        repo = value();
        if (inline === undefined) index += 1;
        break;
      case "--label":
        label = value();
        if (inline === undefined) index += 1;
        break;
      case "--duration":
        durationMs = Number(value());
        if (inline === undefined) index += 1;
        break;
      case "--warmup":
        warmupMs = Number(value());
        if (inline === undefined) index += 1;
        break;
      case "--repeat":
        repeat = Number(value());
        if (inline === undefined) index += 1;
        break;
      case "--out":
        out = value();
        if (inline === undefined) index += 1;
        break;
      case "--profile-dir":
        profileDir = value();
        if (inline === undefined) index += 1;
        break;
      case "--serve-interval":
        serveIntervalMs = Number(value());
        if (inline === undefined) index += 1;
        break;
      case "--store-from":
        storeFrom = value();
        if (inline === undefined) index += 1;
        break;
      case "--keep":
        keep = true;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg}\n${usage()}`);
    }
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("--duration must be positive");
  if (!Number.isFinite(warmupMs) || warmupMs < 0) throw new Error("--warmup must be zero or positive");
  if (!Number.isInteger(repeat) || repeat <= 0) throw new Error("--repeat must be a positive integer");
  if (serveIntervalMs !== undefined && (!Number.isFinite(serveIntervalMs) || serveIntervalMs <= 0)) {
    throw new Error("--serve-interval must be positive");
  }
  const root = resolve(repo);
  return {
    repo: root,
    label: label ?? root.split("/").at(-1) ?? "serve",
    durationMs,
    warmupMs,
    repeat,
    out,
    keep,
    profileDir,
    serveIntervalMs,
    storeFrom: storeFrom === undefined ? undefined : resolve(storeFrom),
  };
}

interface ProcessSample {
  readonly atMs: number;
  readonly cpuSeconds: number;
  readonly rssBytes: number;
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

interface RequestTiming {
  readonly ms: number;
  readonly status: number;
}

interface ClientResult {
  readonly changes: number;
  readonly tails: number;
  readonly resets: number;
  readonly eventLatencies: readonly number[];
  readonly requests: Readonly<Record<string, number>>;
}

interface RunMetrics {
  readonly label: string;
  readonly repo: string;
  readonly home: string;
  readonly durationMs: number;
  readonly loadBefore: readonly number[];
  readonly loadAfter: readonly number[];
  readonly cpuSeconds: number;
  readonly cpuPercentMedian: number;
  readonly cpuPercentPeak: number;
  readonly rssPeakBytes: number;
  readonly eventLatencyP50: number;
  readonly eventLatencyP95: number;
  readonly pendingP50: number;
  readonly pendingP95: number;
  readonly runningP50: number;
  readonly runningP95: number;
  readonly eventsPerSecond: Readonly<Record<string, number>>;
  readonly requests: Readonly<Record<string, number>>;
  readonly profileTop?: readonly ProfileFrame[] | undefined;
  readonly errors: readonly string[];
}

interface ProfileFrame {
  readonly function: string;
  readonly file: string;
  readonly line: number;
  readonly selfMs: number;
  readonly selfPercent: number;
}

interface AggregateMetrics {
  readonly label: string;
  readonly runs: number;
  readonly cpuSeconds: number;
  readonly cpuPercentMedian: number;
  readonly cpuPercentPeak: number;
  readonly rssPeakBytes: number;
  readonly eventLatencyP50: number;
  readonly eventLatencyP95: number;
  readonly pendingP50: number;
  readonly pendingP95: number;
  readonly runningP50: number;
  readonly runningP95: number;
  readonly eventsPerSecond: Readonly<Record<string, number>>;
  readonly requests: Readonly<Record<string, number>>;
  readonly profileTop?: readonly ProfileFrame[] | undefined;
  readonly errors: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Parses the time column of `ps`: [[dd-]hh:]mm:ss[.ss]. */
function parsePsTime(text: string): number | undefined {
  const value = text.trim();
  if (value.length === 0) return undefined;
  let days = 0;
  let rest = value;
  const daySplit = rest.split("-");
  if (daySplit.length === 2) {
    days = Number(daySplit[0]);
    rest = daySplit[1] ?? "";
  } else if (daySplit.length > 2) {
    return undefined;
  }
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![days, seconds, minutes, hours].every(Number.isFinite)) return undefined;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function readProcess(pid: number): { readonly cpuSeconds: number; readonly rssBytes: number } | undefined {
  const result = Bun.spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "time=,rss="],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const line = result.stdout.toString().trim().split("\n").at(-1) ?? "";
  const match = /^(\S+)\s+(\d+)$/.exec(line);
  if (match === null) return undefined;
  const cpuSeconds = parsePsTime(match[1] ?? "");
  const rssKb = Number(match[2]);
  if (cpuSeconds === undefined || !Number.isFinite(rssKb)) return undefined;
  return { cpuSeconds, rssBytes: rssKb * 1024 };
}

function pluginSource(engine: string): string {
  return [
    `import { defineFlow, definePlugin } from ${JSON.stringify(engine)};`,
    'import { existsSync, realpathSync } from "node:fs";',
    'import { join } from "node:path";',
    "",
    "function wait(ms) {",
    "  return new Promise((resolve) => setTimeout(resolve, ms));",
    "}",
    "",
    "const streamFlow = defineFlow({",
    '  name: "bench-stream",',
    '  entry: "stream",',
    "  steps: [",
    '    { id: "stream", kind: "plugin", params: { use: "bench/stream", params: {} }, replay: "safe", next: { done: "finish" } },',
    '    { id: "finish", kind: "end", params: { status: "done" }, replay: "safe" },',
    "  ],",
    "});",
    "",
    "const waitFlow = defineFlow({",
    '  name: "bench-wait",',
    '  entry: "wait",',
    "  steps: [",
    '    { id: "wait", kind: "plugin", params: { use: "bench/wait", params: {} }, replay: "safe", next: { answered: "finish", rejected: "finish", waiting: "person", failed: "finish", interrupted: "finish" } },',
    '    { id: "person", kind: "wait_person", params: { prompt: "Bench pending item", choices: ["yes", "no"] }, replay: "safe", next: { yes: "finish", no: "finish", interrupted: "finish" } },',
    '    { id: "finish", kind: "end", params: { status: "done" }, replay: "safe" },',
    "  ],",
    "});",
    "",
    "function row(object) {",
    "  return {",
    "    id: object.id,",
    "    title: String(object.data.title ?? object.id),",
    '    state: String(object.data.state ?? "running"),',
    "    ...(typeof object.data.note === \"string\" ? { note: object.data.note } : {}),",
    "  };",
    "}",
    "",
    "function liveTail(object) {",
    "  const now = Date.now();",
    '  return { section: "log", tail: `growing ${String(object.id)} ${now}`, status: { text: "Running", since: now }, data: { at: now } };',
    "}",
    "",
    "function chatTail(object) {",
    "  const now = Date.now();",
    '  return { section: "transcript", tail: `**Bot:** streaming reply ${now}`, status: { text: "Thinking", since: now }, data: { at: now } };',
    "}",
    "",
    "export default definePlugin({",
    '  name: "bench",',
    '  kind: "domain",',
    '  version: "0.0.0",',
    '  objects: [{ name: "job" }, { name: "chat" }],',
    "  flows: [streamFlow, waitFlow],",
    "  views: {",
    "    job: {",
    "      row,",
    '      sections: () => [{ id: "log", title: "Log", live: true }],',
    '      load: (_ctx, object) => ({ markdown: `bench ${String(object.id)}` }),',
    "      tail: (_ctx, object) => liveTail(object),",
    "    },",
    "    chat: {",
    "      row,",
    '      sections: () => [{ id: "transcript", title: "Transcript", live: true }],',
    '      load: (_ctx, object) => ({ markdown: `bench chat ${String(object.id)}` }),',
    "      tail: (_ctx, object) => chatTail(object),",
    "    },",
    "  },",
    "  async onTick(ctx) {",
    '    const activeFile = join(ctx.home, "bench-active");',
    '    const releaseFile = join(ctx.home, "bench-release");',
    "    if (existsSync(releaseFile)) {",
    "      // The scenario is over: let any question waiting for a person end.",
    "      for (const run of (await ctx.runLookup?.active()) ?? []) {",
    '        if (run.flow !== "bench-wait") continue;',
    '        try { await ctx.answer(run.runId, "yes"); } catch {}',
    "      }",
    "      return;",
    "    }",
    "    if (!existsSync(activeFile)) return;",
    '    for (const id of ["g1", "g2", "g3"]) {',
    '      if (await ctx.store.get("job", id) === undefined) {',
    '        await ctx.store.put("job", id, { title: `Bench job ${id}`, state: "running" }, "bench seed");',
    "      }",
    "    }",
    '    if (await ctx.store.get("chat", "c1") === undefined) {',
    '      await ctx.store.put("chat", "c1", { title: "Bench chat", state: "running" }, "bench seed");',
    "    }",
    '    for (const id of ["w1", "w2"]) {',
    '      if (await ctx.store.get("job", id) === undefined) {',
    '        await ctx.store.put("job", id, { title: `Bench wait ${id}`, state: "waiting" }, "bench seed");',
    "      }",
    "    }",
    "    const active = await ctx.runLookup?.active();",
    "    const running = (object) => (active ?? []).some((run) => run.object === object);",
    '    for (const id of ["g1", "g2", "g3"]) {',
    '      if (!running(`job:${id}`)) await ctx.start("bench-stream", { type: "job", id });',
    "    }",
    '    if (!running("chat:c1")) await ctx.start("bench-stream", { type: "chat", id: "c1" });',
    '    for (const id of ["w1", "w2"]) {',
    '      if (!running(`job:${id}`)) await ctx.start("bench-wait", { type: "job", id });',
    "    }",
    "  },",
    "  steps: [",
    "    {",
    '      name: "stream",',
    '      results: ["done"],',
    "      async run(ctx) {",
    '        const release = join(ctx.home, "bench-release");',
    "        const until = Date.now() + 120000;",
    "        let line = 0;",
    "        while (!existsSync(release) && Date.now() < until) {",
    "          await ctx.logger.write(`${String(ctx.object?.id ?? \"?\")} ${line} ${Date.now()}`);",
    "          line += 1;",
    "          await wait(50);",
    "        }",
    '        return { result: "done" };',
    "      },",
    "    },",
    "    {",
    '      name: "wait",',
    '      results: ["answered", "rejected", "waiting", "failed", "interrupted"],',
    "      async run(ctx) {",
    "        await ctx.ask({",
    '          prompt: "Bench pending item",',
    '          choices: ["yes", "no"],',
    '          choiceInfo: { yes: { label: "Yes", role: "primary" }, no: { label: "No", role: "destructive" } },',
    "          graceSecs: 120,",
    "        });",
    '        return { result: "answered" };',
    "      },",
    "    },",
    "  ],",
    "});",
    "",
  ].join("\n");
}

/** A consistent copy of one SQLite database; the source may be live. */
function copySqlite(source: string, destination: string): void {
  const database = new Database(source);
  try {
    const escaped = destination.replace(/'/g, "''");
    database.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    database.close();
  }
}

/**
 * Copies the lasting stores into the synthetic home. A real store can have
 * active runs; the copy ends those rows so the benchmark serve does not try to
 * recover runs of plugins it did not load. The copy is the only thing changed.
 */
function copyStore(source: string, destination: string): void {
  for (const name of ["log.sqlite", "plugins.sqlite"]) {
    const from = join(source, name);
    if (existsSync(from)) copySqlite(from, join(destination, name));
  }
  const log = join(destination, "log.sqlite");
  if (!existsSync(log)) return;
  const database = new Database(log);
  try {
    database.exec("UPDATE runs SET ended_at = started_at WHERE ended_at IS NULL");
  } catch {
    // An older store without the runs table keeps what it has.
  } finally {
    database.close();
  }
}

async function makeSyntheticHome(
  options: Options,
  root: string,
  port: number,
): Promise<{ readonly home: string; readonly store: string }> {
  const home = join(root, "home");
  const store = join(root, "store");
  await mkdir(home, { recursive: true });
  await mkdir(store, { recursive: true });
  if (options.storeFrom !== undefined) {
    if (!existsSync(join(options.storeFrom, "log.sqlite"))) {
      throw new Error(`no log.sqlite in --store-from ${options.storeFrom}`);
    }
    copyStore(options.storeFrom, store);
  }
  const engine = join(options.repo, "packages/engine/src/index.ts");
  if (!existsSync(engine)) throw new Error(`no engine at ${engine}`);
  await writeFile(join(home, "bench-plugin.ts"), pluginSource(engine));
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        plugins: [join(home, "bench-plugin.ts")],
        store: { backend: "sqlite", path: join(store, "log.sqlite") },
        http: { enabled: true, port, listen: ["127.0.0.1"] },
        notify: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(home, "triggers.json"), "[]\n");
  await writeFile(join(home, "bench-active"), "1\n");
  return { home, store };
}

class Output {
  text = "";
  private readonly waiters: Array<() => void> = [];

  constructor(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
    for (const stream of [child.stdout, child.stderr]) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          this.text += decoder.decode(chunk, { stream: true });
          this.wake();
        }
      })();
    }
    void child.exited.then(() => this.wake());
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async until(pattern: RegExp, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pattern.test(this.text)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${what}; saw:\n${this.text}`);
      await new Promise<void>((resolveWait) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          resolveWait();
        };
        timer = setTimeout(wake, remaining);
        this.waiters.push(wake);
      });
    }
  }
}

interface Api {
  readonly base: string;
  readonly token: string;
  close(): void;
}

function api(base: string, token: string): Api {
  const controller = new AbortController();
  return {
    base,
    token,
    close: () => controller.abort(),
  };
}

async function getJson(
  client: Api,
  path: string,
  signal?: AbortSignal,
): Promise<{ readonly body: unknown; readonly timing: RequestTiming }> {
  const start = performance.now();
  const response = await fetch(`${client.base}${path}`, {
    headers: { authorization: `Bearer ${client.token}`, "x-operad-client": "bench" },
    ...(signal === undefined ? {} : { signal }),
  });
  const body: unknown = await response.json();
  return { body, timing: { ms: performance.now() - start, status: response.status } };
}

async function postJson(
  client: Api,
  path: string,
  value: unknown,
): Promise<{ readonly body: unknown; readonly timing: RequestTiming }> {
  const start = performance.now();
  const response = await fetch(`${client.base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${client.token}`,
      "content-type": "application/json",
      "x-operad-client": "bench",
    },
    body: JSON.stringify(value),
  });
  const body: unknown = await response.json();
  return { body, timing: { ms: performance.now() - start, status: response.status } };
}

function parseFrame(frame: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
}

function tailTimestamp(event: SseEvent): number | undefined {
  if (event.event !== "tail") return undefined;
  try {
    const value: unknown = JSON.parse(event.data);
    if (!isRecord(value) || !isRecord(value.data)) return undefined;
    const at = value.data.at;
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

async function followEvents(
  client: Api,
  stop: AbortSignal,
  onEvent: (event: SseEvent, receivedAt: number) => void,
): Promise<void> {
  const response = await fetch(`${client.base}/v1/events`, {
    headers: { authorization: `Bearer ${client.token}`, "x-operad-client": "bench" },
    signal: stop,
  });
  if (response.body === null) throw new Error("the event stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return;
      buffer += decoder.decode(read.value, { stream: true });
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split < 0) break;
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = parseFrame(frame);
        if (event !== undefined) onEvent(event, Date.now());
      }
    }
  } catch (error) {
    if (stop.aborted) return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function addRequest(counts: Map<string, number>, path: string): void {
  counts.set(path, (counts.get(path) ?? 0) + 1);
}

async function timedRequest(
  client: Api,
  path: string,
  counts: Map<string, number>,
  timings: Map<string, number[]>,
): Promise<void> {
  try {
    const result = await getJson(client, path);
    addRequest(counts, path);
    const list = timings.get(path);
    if (list === undefined) timings.set(path, [result.timing.ms]);
    else list.push(result.timing.ms);
  } catch {
    // A request that fails under a stopping scenario is not a measurement.
  }
}

interface ScenarioClients {
  readonly done: Promise<readonly ClientResult[]>;
  stop(): void;
}

function startClients(
  client: Api,
  durationMs: number,
  timings: Map<string, number[]>,
  counts: Map<string, number>,
  errors: string[],
): ScenarioClients {
  const stop = new AbortController();
  const deadline = Date.now() + durationMs;

  const makeClient = (kind: "tui" | "desktop"): Promise<ClientResult> => {
    let changes = 0;
    let tails = 0;
    let resets = 0;
    const eventLatencies: number[] = [];
    const requests = new Map<string, number>();
    const localStop = new AbortController();
    stop.signal.addEventListener("abort", () => localStop.abort(), { once: true });
    const eventLoop = followEvents(client, localStop.signal, (event, receivedAt) => {
      if (event.event === "tail") {
        tails += 1;
        const at = tailTimestamp(event);
        if (at !== undefined) eventLatencies.push(receivedAt - at);
      } else if (event.event === "reset") {
        resets += 1;
      } else {
        changes += 1;
      }
    }).catch((error: unknown) => {
      if (!localStop.signal.aborted) errors.push(`${kind} events: ${error instanceof Error ? error.message : String(error)}`);
    });
    const loops: Promise<void>[] = [eventLoop];
    const loop = (intervalMs: number, paths: readonly string[]): void => {
      loops.push((async () => {
        for (;;) {
          if (localStop.signal.aborted || Date.now() >= deadline) return;
          for (const path of paths) {
            if (localStop.signal.aborted || Date.now() >= deadline) return;
            await timedRequest(client, path, requests, timings);
          }
          await sleep(intervalMs);
        }
      })());
    };
    if (kind === "tui") {
      loop(250, ["/v1/pending", "/v1/running"]);
      loop(500, ["/v1/objects/chat:c1/sections/transcript", "/v1/objects/job:g1/sections/log"]);
      loop(1000, ["/v1/objects?type=job"]);
    } else {
      loop(500, ["/v1/pending", "/v1/running"]);
      loop(750, ["/v1/objects/chat:c1/sections/transcript", "/v1/objects/job:g2/sections/log"]);
      loop(1000, ["/v1/objects?type=job", "/v1/objects?type=chat", "/v1/objects/chat:c1"]);
    }
    return Promise.all(loops).then(() => ({
      changes,
      tails,
      resets,
      eventLatencies,
      requests: Object.fromEntries(requests),
    }));
  };

  const clients = [makeClient("tui"), makeClient("desktop")];
  return {
    done: Promise.all(clients),
    stop: () => stop.abort(),
  };
}

async function startProbe(
  client: Api,
  durationMs: number,
  timings: Map<string, number[]>,
  counts: Map<string, number>,
): Promise<{ readonly done: Promise<void>; readonly stop: () => void }> {
  const stop = new AbortController();
  const deadline = Date.now() + durationMs;
  const done = (async () => {
    while (!stop.signal.aborted && Date.now() < deadline) {
      for (const path of ["/v1/pending", "/v1/running"]) {
        if (stop.signal.aborted || Date.now() >= deadline) return;
        await timedRequest(client, path, counts, timings);
      }
      await sleep(1000);
    }
  })();
  return { done, stop: () => stop.abort() };
}

async function waitForReady(client: Api, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const running = await getJson(client, "/v1/running");
      const pending = await getJson(client, "/v1/pending");
      const runningCount = countOf(running.body);
      const pendingCount = countOf(pending.body);
      last = `running ${runningCount}, pending ${pendingCount}`;
      if (runningCount >= 4 && pendingCount >= 2) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`the scenario was not ready in time (${last})`);
}

async function releaseRuns(client: Api, home: string): Promise<void> {
  await writeFile(join(home, "bench-release"), "1\n");
  await rm(join(home, "bench-active"), { force: true });
  // Answer the questions directly too; the plugin's cleanup answers any the
  // request misses. This is cleanup, outside the measured time.
  try {
    const pending = await getJson(client, "/v1/pending");
    if (Array.isArray(pending.body)) {
      for (const item of pending.body) {
        if (!isRecord(item)) continue;
        const runId = item.runId;
        const waitId = item.waitId;
        const choices = item.choices;
        if (typeof runId !== "string" || typeof waitId !== "string") continue;
        const choice = Array.isArray(choices) && typeof choices[0] === "string" ? choices[0] : undefined;
        if (choice === undefined) continue;
        try {
          await postJson(client, "/v1/answer", { runId, waitId, choice });
        } catch {
          // The run may already have ended.
        }
      }
    }
  } catch {
    // The list may be gone with the run.
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const running = await getJson(client, "/v1/running");
      if (countOf(running.body) === 0) return;
    } catch {
      return;
    }
    await sleep(100);
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await sleep(100);
    }
  }
  return undefined;
}

function parseCpuProfile(
  text: string,
  repo: string,
  startMicros: number | undefined,
  endMicros: number | undefined,
): readonly ProfileFrame[] {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.samples) || !Array.isArray(value.timeDeltas)) {
    return [];
  }
  const profileStart = typeof value.startTime === "number" ? value.startTime : 0;
  let base = repo;
  try {
    base = realpathSync(repo);
  } catch {
    // Keep the given path when it cannot be resolved.
  }
  const nodes = new Map<number, { readonly function: string; readonly file: string; readonly line: number }>();
  for (const node of value.nodes) {
    if (!isRecord(node)) continue;
    const id = node.id;
    const call = node.callFrame;
    if (typeof id !== "number" || !isRecord(call)) continue;
    const functionName = typeof call.functionName === "string" ? call.functionName : "(anonymous)";
    const url = typeof call.url === "string" ? call.url : "";
    const rawLine = typeof call.lineNumber === "number" ? call.lineNumber + 1 : 0;
    let file = url;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        // Keep the URL when it does not parse as a file.
      }
    }
    if (file.startsWith(base)) file = relative(base, file);
    else if (file.startsWith(repo)) file = relative(repo, file);
    nodes.set(id, { function: functionName, file, line: rawLine });
  }
  const self = new Map<number, number>();
  let total = 0;
  let elapsed = 0;
  for (let index = 0; index < value.samples.length; index += 1) {
    const id = value.samples[index];
    const delta = value.timeDeltas[index];
    if (typeof id !== "number" || typeof delta !== "number") continue;
    const at = profileStart + elapsed;
    elapsed += delta;
    if (startMicros !== undefined && at < startMicros) continue;
    if (endMicros !== undefined && at > endMicros) continue;
    self.set(id, (self.get(id) ?? 0) + delta);
    total += delta;
  }
  if (total <= 0) return [];
  const frames: ProfileFrame[] = [];
  for (const [id, micros] of self) {
    const node = nodes.get(id);
    if (node === undefined || micros <= 0) continue;
    if (node.function === "(root)" || node.function === "(idle)") continue;
    if (node.file.length === 0 || node.line <= 0) continue;
    if (node.file.startsWith("node:") || node.file.startsWith("internal:")) continue;
    if (node.file.startsWith("/")) continue;
    frames.push({
      function: node.function,
      file: node.file,
      line: node.line,
      selfMs: round(micros / 1000, 1),
      selfPercent: round((micros / total) * 100, 1),
    });
  }
  return frames.sort((left, right) => right.selfMs - left.selfMs).slice(0, 10);
}

async function readProfile(
  dir: string,
  repo: string,
  startMicros: number | undefined,
  endMicros: number | undefined,
): Promise<readonly ProfileFrame[]> {
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".cpuprofile"));
    if (files.length === 0) return [];
    const newest = files.map((name) => join(dir, name)).sort().at(-1);
    if (newest === undefined) return [];
    const text = await waitForFile(newest, 5_000);
    return text === undefined ? [] : parseCpuProfile(text, repo, startMicros, endMicros);
  } catch {
    return [];
  }
}

async function stopServe(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    sleep(10_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function runOnce(options: Options, index: number): Promise<RunMetrics> {
  const port = await freePort();
  const root = await mkdtemp(join(tmpdir(), "operad-serve-bench-"));
  const { home } = await makeSyntheticHome(options, root, port);
  const profileDir = options.profileDir === undefined ? undefined : join(options.profileDir, `run-${index + 1}`);
  if (profileDir !== undefined) await mkdir(profileDir, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OPERAD_HOME: home,
  };
  if (options.serveIntervalMs !== undefined) env.OPERAD_SERVE_INTERVAL_MS = String(options.serveIntervalMs);
  const serveEntry = join(options.repo, "packages/cli/bin/operad.ts");
  const command = profileDir === undefined
    ? [process.execPath, serveEntry, "serve"]
    : [process.execPath, "--cpu-prof", `--cpu-prof-dir=${profileDir}`, "--cpu-prof-name=serve.cpuprofile", serveEntry, "serve"];
  const child = Bun.spawn({
    cmd: command,
    cwd: home,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Output(child);
  const errors: string[] = [];
  const timings = new Map<string, number[]>();
  const requestCounts = new Map<string, number>();
  let client: Api | undefined;
  let cpuBaseline: number | undefined;
  let cpuFinal: number | undefined;
  let measuredStartMs: number | undefined;
  let measuredEndMs: number | undefined;
  const samples: ProcessSample[] = [];
  const loadBefore = loadavg();
  try {
    await output.until(/http http:\/\/\S+/, 30_000, "the http address");
    const match = /http (http:\/\/\S+)/.exec(output.text);
    const base = match?.[1];
    if (base === undefined) throw new Error("serve printed no http URL");
    const tokenText = await waitForFile(join(home, "secrets/http.json"), 5_000);
    if (tokenText === undefined) throw new Error("serve wrote no http token");
    const tokenValue: unknown = JSON.parse(tokenText);
    const token = isRecord(tokenValue) && typeof tokenValue.token === "string" ? tokenValue.token : undefined;
    if (token === undefined) throw new Error("the http token file has no token");

    client = api(base, token);
    await waitForReady(client, 30_000);
    if (options.warmupMs > 0) await sleep(options.warmupMs);

    const before = readProcess(child.pid);
    cpuBaseline = before?.cpuSeconds;
    measuredStartMs = Date.now();
    measuredEndMs = measuredStartMs + options.durationMs;
    const scenario = startClients(client, options.durationMs, timings, requestCounts, errors);
    const probe = await startProbe(client, options.durationMs, timings, requestCounts);
    const measuredFrom = performance.now();
    const sampling = (async () => {
      while (performance.now() - measuredFrom < options.durationMs) {
        const sample = readProcess(child.pid);
        if (sample !== undefined) {
          samples.push({
            atMs: performance.now() - measuredFrom,
            cpuSeconds: sample.cpuSeconds,
            rssBytes: sample.rssBytes,
          });
        }
        await sleep(250);
      }
    })();
    await Promise.all([sampling, probe.done]);
    scenario.stop();
    probe.stop();
    const clients = await scenario.done;
    for (const result of clients) {
      for (const [path, count] of Object.entries(result.requests)) {
        requestCounts.set(path, (requestCounts.get(path) ?? 0) + count);
      }
    }
    const after = readProcess(child.pid);
    cpuFinal = after?.cpuSeconds;

    const tailLatencies = clients.flatMap((result) => result.eventLatencies);
    const pending = timings.get("/v1/pending") ?? [];
    const running = timings.get("/v1/running") ?? [];
    const cpuPercents: number[] = [];
    for (let at = 1; at < samples.length; at += 1) {
      const previous = samples[at - 1];
      const current = samples[at];
      if (previous === undefined || current === undefined) continue;
      const seconds = (current.atMs - previous.atMs) / 1000;
      if (seconds <= 0) continue;
      cpuPercents.push(Math.max(0, current.cpuSeconds - previous.cpuSeconds) / seconds * 100);
    }
    const events = new Map<string, number>();
    for (const result of clients) {
      events.set("change", (events.get("change") ?? 0) + result.changes);
      events.set("tail", (events.get("tail") ?? 0) + result.tails);
      events.set("reset", (events.get("reset") ?? 0) + result.resets);
    }
    const perSecond = Object.fromEntries(
      [...events].map(([name, count]) => [name, round(count / (options.durationMs / 1000), 2)]),
    );
    const requests = Object.fromEntries([...requestCounts].sort(([left], [right]) => left.localeCompare(right)));
    const cpuSeconds = cpuBaseline !== undefined && cpuFinal !== undefined ? Math.max(0, cpuFinal - cpuBaseline) : 0;
    const loadAfter = loadavg();
    await releaseRuns(client, home);
    // The profile is written when serve exits.
    await stopServe(child);
    const profileTop = profileDir === undefined
      ? undefined
      : await readProfile(
          profileDir,
          options.repo,
          measuredStartMs === undefined ? undefined : measuredStartMs * 1000,
          measuredEndMs === undefined ? undefined : measuredEndMs * 1000,
        );
    const result: RunMetrics = {
      label: options.label,
      repo: options.repo,
      home,
      durationMs: options.durationMs,
      loadBefore,
      loadAfter,
      cpuSeconds: round(cpuSeconds, 2),
      cpuPercentMedian: round(median(cpuPercents), 1),
      cpuPercentPeak: round(samples.length === 0 ? 0 : Math.max(...cpuPercents), 1),
      rssPeakBytes: samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.rssBytes)),
      eventLatencyP50: round(percentile(tailLatencies, 50), 1),
      eventLatencyP95: round(percentile(tailLatencies, 95), 1),
      pendingP50: round(percentile(pending, 50), 1),
      pendingP95: round(percentile(pending, 95), 1),
      runningP50: round(percentile(running, 50), 1),
      runningP95: round(percentile(running, 95), 1),
      eventsPerSecond: perSecond,
      requests,
      ...(profileTop === undefined ? {} : { profileTop }),
      errors,
    };
    return result;
  } finally {
    client?.close();
    await stopServe(child);
    if (!options.keep) await rm(root, { recursive: true, force: true });
    else console.error(`kept ${root}`);
  }
}

function aggregate(runs: readonly RunMetrics[], label: string): AggregateMetrics {
  const eventP50 = runs.map((run) => run.eventLatencyP50);
  const eventP95 = runs.map((run) => run.eventLatencyP95);
  const pendingP50 = runs.map((run) => run.pendingP50);
  const pendingP95 = runs.map((run) => run.pendingP95);
  const runningP50 = runs.map((run) => run.runningP50);
  const runningP95 = runs.map((run) => run.runningP95);
  const eventNames = new Set(runs.flatMap((run) => Object.keys(run.eventsPerSecond)));
  const requestNames = new Set(runs.flatMap((run) => Object.keys(run.requests)));
  const eventRates: Record<string, number> = {};
  for (const name of eventNames) {
    eventRates[name] = round(median(runs.map((run) => run.eventsPerSecond[name] ?? 0)), 2);
  }
  const requestCounts: Record<string, number> = {};
  for (const name of requestNames) {
    requestCounts[name] = Math.round(median(runs.map((run) => run.requests[name] ?? 0)));
  }
  const profiled = runs.filter((run) => run.profileTop !== undefined);
  const profileMap = new Map<string, { frame: ProfileFrame; totalMs: number; totalPercent: number }>();
  for (const run of profiled) {
    for (const frame of run.profileTop ?? []) {
      const key = `${frame.file}:${frame.line}:${frame.function}`;
      const entry = profileMap.get(key);
      if (entry === undefined) {
        profileMap.set(key, { frame, totalMs: frame.selfMs, totalPercent: frame.selfPercent });
      } else {
        entry.totalMs += frame.selfMs;
        entry.totalPercent += frame.selfPercent;
      }
    }
  }
  const profileTop = profiled.length === 0
    ? undefined
    : [...profileMap.values()]
        .map((entry) => ({
          ...entry.frame,
          selfMs: round(entry.totalMs / profiled.length, 1),
          selfPercent: round(entry.totalPercent / profiled.length, 1),
        }))
        .sort((left, right) => right.selfMs - left.selfMs)
        .slice(0, 10);
  return {
    label,
    runs: runs.length,
    cpuSeconds: round(median(runs.map((run) => run.cpuSeconds)), 2),
    cpuPercentMedian: round(median(runs.map((run) => run.cpuPercentMedian)), 1),
    cpuPercentPeak: round(median(runs.map((run) => run.cpuPercentPeak)), 1),
    rssPeakBytes: Math.round(median(runs.map((run) => run.rssPeakBytes))),
    eventLatencyP50: round(median(eventP50), 1),
    eventLatencyP95: round(median(eventP95), 1),
    pendingP50: round(median(pendingP50), 1),
    pendingP95: round(median(pendingP95), 1),
    runningP50: round(median(runningP50), 1),
    runningP95: round(median(runningP95), 1),
    eventsPerSecond: eventRates,
    requests: requestCounts,
    ...(profileTop === undefined ? {} : { profileTop }),
    errors: runs.flatMap((run) => run.errors),
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function printSummary(value: AggregateMetrics, runs: readonly RunMetrics[]): void {
  console.log(`\n${value.label}: ${value.runs} run(s), median or pooled as noted`);
  console.log(`  serve CPU seconds       ${value.cpuSeconds.toFixed(2)}`);
  console.log(`  CPU median / peak       ${value.cpuPercentMedian.toFixed(1)}% / ${value.cpuPercentPeak.toFixed(1)}%`);
  console.log(`  peak RSS                ${formatBytes(value.rssPeakBytes)}`);
  console.log(`  tail event p50 / p95    ${value.eventLatencyP50.toFixed(1)} ms / ${value.eventLatencyP95.toFixed(1)} ms`);
  console.log(`  pending p50 / p95       ${value.pendingP50.toFixed(1)} ms / ${value.pendingP95.toFixed(1)} ms`);
  console.log(`  running p50 / p95       ${value.runningP50.toFixed(1)} ms / ${value.runningP95.toFixed(1)} ms`);
  console.log(`  events per second       ${JSON.stringify(value.eventsPerSecond)}`);
  console.log(`  requests                ${JSON.stringify(value.requests)}`);
  if (value.profileTop !== undefined && value.profileTop.length > 0) {
    console.log("  top self time");
    for (const frame of value.profileTop.slice(0, 5)) {
      console.log(`    ${frame.selfPercent.toFixed(1).padStart(5)}%  ${frame.selfMs.toFixed(1).padStart(8)} ms  ${frame.file}:${frame.line}  ${frame.function}`);
    }
  }
  if (value.errors.length > 0) console.log(`  errors                  ${value.errors.join("; ")}`);
  for (const run of runs) {
    console.log(
      `  ${run.label} run load ${run.loadBefore.map((load) => load.toFixed(2)).join("/")} -> ${run.loadAfter.map((load) => load.toFixed(2)).join("/")}  ` +
        `CPU ${run.cpuSeconds.toFixed(2)}s ${run.cpuPercentMedian.toFixed(1)}%/${run.cpuPercentPeak.toFixed(1)}%  ` +
        `RSS ${formatBytes(run.rssPeakBytes)}  tail ${run.eventLatencyP50.toFixed(1)}/${run.eventLatencyP95.toFixed(1)} ms  ` +
        `pending ${run.pendingP50.toFixed(1)}/${run.pendingP95.toFixed(1)} ms  running ${run.runningP50.toFixed(1)}/${run.runningP95.toFixed(1)} ms`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(options.repo, "packages/cli/bin/operad.ts"))) {
    throw new Error(`no operad CLI at ${options.repo}`);
  }
  console.log(
    `${options.label}: ${cpus().length} CPUs, load ${loadavg().map((load) => load.toFixed(2)).join(" ")} before; ` +
      `${options.repeat} run(s) of ${options.durationMs} ms`,
  );
  const runs: RunMetrics[] = [];
  for (let index = 0; index < options.repeat; index += 1) {
    const result = await runOnce(options, index);
    runs.push(result);
    console.log(
      `${options.label} run ${index + 1}/${options.repeat}: ${result.cpuSeconds.toFixed(2)}s CPU, ` +
        `${result.cpuPercentMedian.toFixed(1)}% median, ${result.cpuPercentPeak.toFixed(1)}% peak, ` +
        `tail p95 ${result.eventLatencyP95.toFixed(1)} ms, pending p95 ${result.pendingP95.toFixed(1)} ms, ` +
        `running p95 ${result.runningP95.toFixed(1)} ms`,
    );
  }
  const summary = aggregate(runs, options.label);
  const output = {
    kind: "operad-serve-bench",
    version: 1,
    scenario: {
      home: "synthetic",
      durationMs: options.durationMs,
      warmupMs: options.warmupMs,
      runs: "3 growing jobs, 1 streaming chat, 2 person waits",
      clients: "tui and desktop following events; periodic pending/running probe",
      store: options.storeFrom === undefined ? "synthetic" : `copied from ${options.storeFrom}`,
      metricNote:
        "CPU and RSS are the serve process only. Event latency is tail event data.at to client read. Log reads are not counted.",
      ...(options.serveIntervalMs === undefined ? {} : { serveIntervalMs: options.serveIntervalMs }),
    },
    label: options.label,
    repo: options.repo,
    aggregate: summary,
    runs,
  };
  printSummary(summary, runs);
  if (options.out !== undefined) {
    await mkdir(dirname(resolve(options.out)), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`wrote ${options.out}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
