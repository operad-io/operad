import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TuiClock } from "../src/live.ts";
import type { TuiState, TuiStateEvent } from "../src/state.ts";
import { drawState } from "../src/view/index.ts";
import {
  MemoryPluginStore,
  createViews,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  startHttpServer,
  storeRootOf,
  type HttpServerHandle,
  type LogBackend,
  type PluginRegistry,
  type ViewRow,
  type Views,
} from "@operad-io/engine";

import { freePort, tempRoot } from "@operad-io/engine/testing";

export { freePort, tempRoot };

const pluginPath = fileURLToPath(
  new URL("./fixtures/plugin.ts", import.meta.url),
);

export interface TuiHarness {
  readonly root: string;
  readonly home: string;
  readonly store: MemoryPluginStore;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly views: Views;
  readonly server: HttpServerHandle;
  readonly base: string;
  readonly token: string;
  close(): Promise<void>;
}

export interface TuiHarnessOptions {
  readonly loadTimeoutMs?: number | undefined;
  readonly maxEventIds?: number | undefined;
}

export async function makeHarness(
  options: TuiHarnessOptions = {},
): Promise<TuiHarness> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
      http: { enabled: true, port, listen: ["127.0.0.1"] },
    }),
  );
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store = new MemoryPluginStore({ root: storeRoot });
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({ home, store });
  const views = createViews({
    registry,
    store,
    log,
    loadTimeoutMs: options.loadTimeoutMs ?? 50,
    onLog: () => undefined,
  });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    ...(options.maxEventIds === undefined
      ? {}
      : { maxEventIds: options.maxEventIds }),
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  if (token === undefined) throw new Error("the server created no token");
  const base = server.urls[0] ?? `http://127.0.0.1:${port}`;

  return {
    root,
    home,
    store,
    log,
    registry,
    views,
    server,
    base,
    token: token.token,
    async close() {
      await server.stop();
      views.close();
      await log.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A clock that runs a timer as soon as the current work yields. */
export const immediateClock: TuiClock = {
  after(run) {
    let live = true;
    setTimeout(() => {
      if (live) run();
    }, 0);
    return () => {
      live = false;
    };
  },
};

/** A clock the test moves by hand. */
export class ManualClock implements TuiClock {
  private now = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  private next = 0;

  after(run: () => void, ms: number): () => void {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, run });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Moves time forward and runs every timer that falls due, in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** A whole list of plugin rows, the way the shell answers a load. */
export function treeRows(
  tabId: string,
  rows: readonly ViewRow[],
  extra: {
    readonly hidden?: number | undefined;
    readonly filter?: string | undefined;
    readonly filterSeq?: number | undefined;
    readonly generation?: number | undefined;
  } = {},
): TuiStateEvent {
  const fallback = tabId.startsWith("plugin:") ? tabId.slice("plugin:".length) : tabId;
  const typeOf = (row: ViewRow): string =>
    row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : fallback;
  return {
    type: "tree",
    tabId,
    level: "roots",
    entries: rows.map((row) => ({ row, type: typeOf(row) })),
    ...(extra.hidden === undefined ? {} : { hidden: extra.hidden }),
    ...(extra.filter === undefined ? {} : { filter: extra.filter }),
    ...(extra.filterSeq === undefined ? {} : { filterSeq: extra.filterSeq }),
    ...(extra.generation === undefined ? {} : { generation: extra.generation }),
  };
}

/** The header line the screen draws. */
export function headerOf(state: TuiState): string {
  return drawState(state).header.chunks.map((chunk) => chunk.text).join("");
}

/** The footer line the screen draws. */
export function footerOf(state: TuiState): string {
  return drawState(state).footer.chunks.map((chunk) => chunk.text).join("").trimStart();
}
