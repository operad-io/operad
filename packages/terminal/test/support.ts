/**
 * A `serve` in this process with the terminal plugin: a real HTTP port, real
 * pseudo terminals and real child processes. Every wait is for an event.
 */

import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  definePlugin,
  Kernel,
  openLog,
  PluginRegistry,
  readHttpToken,
  SqlitePluginStore,
  startHttpServer,
  type HttpServerOptions,
  type PluginDefinition,
} from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "@operad-io/engine/testing";
import headless from "@xterm/headless";
import {
  createTerminalPlugin,
  type GroupInfo,
  type TerminalInfo,
  type TerminalList,
  type TerminalPluginOptions,
} from "../src/index.ts";

const closers: (() => Promise<void> | void)[] = [];

/** Ends every stream and server a test opened, newest first. */
export async function closeAll(): Promise<void> {
  for (const close of closers.splice(0).reverse()) await close();
  await cleanupTempRoots();
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

export interface World {
  readonly root: string;
  readonly home: string;
  /** A registered repository with one commit. */
  readonly repository: string;
}

export async function makeWorld(): Promise<World> {
  const root = realpathSync(await tempRoot("operad-terminal-test-"));
  const home = join(root, "home");
  const repository = join(root, "repository");
  mkdirSync(home, { recursive: true });
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-q", "-b", "main");
  git(repository, "commit", "-q", "--allow-empty", "-m", "start");
  return { root, home, repository };
}

/** Adds a git worktree of the repository and answers its path. */
export function addWorktree(world: World, name: string): string {
  const path = join(world.repository, ".operad-worktrees", name);
  git(world.repository, "worktree", "add", "-q", "-b", `work/${name}`, path);
  return path;
}

export interface Answer<T> {
  readonly status: number;
  readonly body: T;
}

export interface Refusal {
  readonly error: { readonly kind: string; readonly message: string };
}

export interface Event {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

/** One client of `/v1/events`. */
export interface Stream {
  readonly status: number;
  /** The terminal events received so far. */
  readonly events: readonly Event[];
  /** The output of one terminal received so far. */
  output(id: string): string;
  /** Settles with the first event, received or to come, that matches. */
  until(match: (event: Event) => boolean): Promise<Event>;
  /** Settles when the screen and the output of `id` together show `pattern`. */
  shows(id: string, pattern: RegExp): Promise<void>;
  /** Disconnects, as a client that goes away does. */
  close(): void;
}

export interface Served {
  readonly url: string;
  request<T = Refusal>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Answer<T>>;
  start(input: {
    command?: string;
    folder: string;
    cols?: number;
    rows?: number;
    group?: string;
  }): Promise<TerminalInfo>;
  input(id: string, data: string): Promise<void>;
  list(): Promise<TerminalList>;
  group(name: string): Promise<GroupInfo>;
  /** Opens an event stream naming these terminals; none: changes only. */
  stream(...ids: string[]): Promise<Stream>;
  /** Settles when the terminal ended, with how. */
  ended(id: string): Promise<TerminalInfo>;
  /** Settles once serve noticed that a client left an event stream. */
  left(): Promise<void>;
  /**
   * Closes a terminal that ignores the hang up, which takes serve the whole
   * grace: a stop begun before this call has ended when it returns.
   */
  outlast(folder: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ServeOptions {
  readonly plugin?: TerminalPluginOptions;
  readonly server?: Partial<HttpServerOptions>;
  /** Plugins loaded beside the terminal plugin. */
  readonly plugins?: readonly PluginDefinition[];
  /** Whether a plugin that registers the world's repository is loaded; default yes. */
  readonly registersRepository?: boolean;
  /** False: serve could not load the trigger rules. */
  readonly rulesLoaded?: boolean;
}

function repositories(world: World): PluginDefinition {
  return definePlugin({
    name: "repos",
    kind: "domain",
    version: "1.0.0",
    projectSettings: {
      repositories: () => [{ name: "repository", path: world.repository }],
      files: [],
    },
  });
}

export async function serve(world: World, options: ServeOptions = {}): Promise<Served> {
  const logs: string[] = [];
  const onLog = (message: string): void => {
    logs.push(message);
  };
  const store = new SqlitePluginStore({ root: join(world.root, "store", "plugins") });
  const plugin = createTerminalPlugin({
    shell: "/bin/bash",
    // No start-up files of the person who runs the tests.
    env: { HOME: world.home, BASH_SILENCE_DEPRECATION_WARNING: "1" },
    ...options.plugin,
  });
  const registry = new PluginRegistry(
    [
      ...(options.registersRepository === false ? [] : [repositories(world)]),
      ...(options.plugins ?? []),
      plugin,
    ],
    { home: world.home, cwd: world.home, store, onLog },
  );
  const log = openLog({ path: join(world.root, "store", "log.sqlite") });
  const views = createViews({ registry, store, log, onLog });
  const kernel = new Kernel({
    log,
    registry,
    home: world.home,
    storeRoot: join(world.root, "store"),
    rules: [],
    client: views,
    onLog,
  });
  let departed = (): void => undefined;
  const leaving = new Promise<void>((resolve) => {
    departed = resolve;
  });
  const server = await startHttpServer({
    home: world.home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    pluginHttp: (name) => {
      const served = kernel.pluginHttp(name);
      const stream = served?.stream?.bind(served);
      if (served === undefined || stream === undefined) return served;
      return {
        request: served.request.bind(served),
        stream(request) {
          const joined = stream(request);
          if (!("open" in joined)) return joined;
          return {
            open(send) {
              const end = joined.open(send);
              return () => {
                end();
                departed();
              };
            },
          };
        },
      };
    },
    onLog,
    ...options.server,
  });
  await kernel.startSources(options.rulesLoaded === false ? { rulesLoaded: false } : {});
  const url = server.urls[0] ?? "";
  const token = (await readHttpToken(world.home))?.token ?? "";
  const authorization = { authorization: `Bearer ${token}` };
  const streams: Stream[] = [];

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const stream of streams) stream.close();
    await server.stop();
    await kernel.stopSources();
    views.close();
    store.close();
    await log.close();
  };
  closers.push(stop);

  const request = async <T = Refusal>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer<T>> => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { ...authorization, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  };

  const expectStatus = <T>(answer: Answer<T>, status: number): T => {
    if (answer.status !== status) {
      throw new Error(`status ${answer.status}: ${JSON.stringify(answer.body)}`);
    }
    return answer.body;
  };

  const list = async (): Promise<TerminalList> =>
    expectStatus(await request<TerminalList>("GET", "/v1/terminal"), 200);

  const stream = async (...ids: string[]): Promise<Stream> => {
    const opened = await openStream(
      `${url}/v1/events?${ids.length === 0 ? "terminal=" : ids.map((id) => `terminal=${id}`).join("&")}`,
      authorization,
    );
    streams.push(opened);
    return opened;
  };

  const served: Served = {
    url,
    request,
    list,
    stream,
    stop,
    left: () => leaving,
    async outlast(folder) {
      const slow = await served.start({ command: "trap '' HUP TERM; echo ready-$((1+1)); read x", folder });
      const watching = await stream(slow.id);
      await watching.shows(slow.id, /ready-2/);
      expectStatus(await request("POST", `/v1/terminal/${slow.id}/close`, {}), 200);
      watching.close();
    },
    async start(input) {
      const answer = await request<{ terminal: TerminalInfo }>("POST", "/v1/terminal", {
        cols: 80,
        rows: 24,
        ...input,
      });
      return expectStatus(answer, 201).terminal;
    },
    async input(id, data) {
      expectStatus(await request("POST", `/v1/terminal/${id}/input`, { data }), 200);
    },
    async group(name) {
      const answer = await request<{ group: GroupInfo }>("POST", "/v1/terminal/groups", { name });
      return expectStatus(answer, 201).group;
    },
    async ended(id) {
      // Subscribed before the list is read, so an end between them is not missed.
      const changes = await stream();
      let seen = 0;
      for (;;) {
        const found = (await list()).terminals.find((terminal) => terminal.id === id);
        if (found === undefined) throw new Error(`no terminal "${id}"`);
        if (found.state === "ended") {
          changes.close();
          return found;
        }
        let count = 0;
        await changes.until((event) => event.name === "change" && ++count > seen);
        seen = count;
      }
    },
  };
  return served;
}

async function openStream(url: string, headers: Record<string, string>): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(url, { headers, signal: abort.signal });
  const events: Event[] = [];
  const waiters = new Set<() => void>();
  let over = false;
  const read = async (): Promise<void> => {
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const name = /^event: terminal\.(.+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (name !== undefined && data !== undefined) {
          events.push({ name, data: JSON.parse(data) as Record<string, unknown> });
        }
        at = buffer.indexOf("\n\n");
      }
      for (const waiter of [...waiters]) waiter();
    }
  };
  if (response.ok) {
    void read()
      .catch(() => undefined)
      .finally(() => {
        over = true;
        for (const waiter of [...waiters]) waiter();
      });
  }

  const wait = <T>(look: () => T | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const found = look();
        if (found !== undefined) {
          waiters.delete(check);
          resolve(found);
        } else if (over) {
          waiters.delete(check);
          reject(new Error(`the stream ended; it got ${JSON.stringify(events)}`));
        }
      };
      waiters.add(check);
      check();
    });

  const output = (id: string): string =>
    events
      .filter((event) => event.name === "output" && event.data.id === id)
      .map((event) => String(event.data.data))
      .join("");

  return {
    status: response.status,
    events,
    output,
    until: (match) => wait(() => events.find(match)),
    async shows(id, pattern) {
      await wait(() => {
        const screen = events.find((event) => event.name === "screen" && event.data.id === id);
        return pattern.test(`${String(screen?.data.data ?? "")}${output(id)}`) ? true : undefined;
      });
    },
    close: () => abort.abort(),
  };
}

/** The lines a fresh terminal shows after it is given a serialized screen and what follows. */
export async function render(data: string, cols = 80, rows = 24): Promise<string[]> {
  const terminal = new headless.Terminal({ cols, rows, scrollback: 100_000, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  terminal.dispose();
  return lines;
}

/**
 * A process that ignores TERM and HUP and holds a FIFO open for as long as it
 * lives, started by `command`: `up` settles once it runs, `gone` once the FIFO
 * has no writer left, which is when it ended.
 */
export function lingering(world: World, name: string) {
  const fifo = join(world.root, `alive-${name}`);
  execFileSync("mkfifo", [fifo]);
  const stream = createReadStream(fifo, { encoding: "utf8" });
  let ended = false;
  const up = new Promise<void>((resolve) => stream.once("data", () => resolve()));
  const gone = new Promise<void>((resolve) =>
    stream.once("end", () => {
      ended = true;
      resolve();
    }),
  );
  return {
    command: `trap '' TERM HUP; exec 3>'${fifo}'; echo up >&3; sleep 600`,
    up,
    gone,
    ended: () => ended,
  };
}
