import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  openConfigLog,
  readConfig,
} from "@operad-io/engine";
import {
  INSTRUCTIONS,
  PROTOCOL_VERSION,
  TOOLS,
} from "../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(
  new URL("../../cli/bin/operad.ts", import.meta.url),
);
const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

interface Home {
  readonly root: string;
  readonly home: string;
}

async function makeHome(): Promise<Home> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
    }),
  );
  return { root, home };
}

function seed(home: string, id: string, data: Record<string, unknown>): void {
  const root = join(home, "..", "store", "plugins");
  new FilePluginStore({ root }).put("item", id, data, "seed");
}

async function addRun(
  home: string,
  object: string,
  waiting: { readonly prompt: string } | undefined,
): Promise<string> {
  const log = openConfigLog(await readConfig(home));
  try {
    const info = await log.startRun("demo-flow", object);
    if (waiting !== undefined) {
      await log.append(info.runId, 0, [
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "ask",
            prompt: waiting.prompt,
            choices: ["yes"],
            waitKind: "step",
            effectId: null,
          },
          cause: "test",
        },
      ]);
    }
    return info.runId;
  } finally {
    await log.close();
  }
}

interface ByteRead {
  readonly done: boolean;
  readonly value?: Uint8Array | undefined;
}

interface ByteReader {
  read(): Promise<ByteRead>;
  cancel(): Promise<void>;
}

class JsonLines {
  readonly seen: string[] = [];
  private readonly reader: ByteReader;
  private readonly decoder = new TextDecoder();
  private readonly lines: string[] = [];
  private readonly waiting: ((line: string | undefined) => void)[] = [];
  private buffer = "";
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    for (;;) {
      const read = await this.reader.read();
      if (read.done) {
        this.ended = true;
        this.buffer += this.decoder.decode();
        this.emitLines();
        while (this.waiting.length > 0) {
          const resolve = this.waiting.shift();
          resolve?.(undefined);
        }
        return;
      }
      if (read.value !== undefined) {
        this.buffer += this.decoder.decode(read.value, { stream: true });
      }
      this.emitLines();
    }
  }

  private emitLines(): void {
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) return;
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      if (line === "") continue;
      const resolve = this.waiting.shift();
      if (resolve !== undefined) resolve(line);
      else this.lines.push(line);
      this.seen.push(line);
    }
  }

  next(timeoutMs = 10_000): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.reject(new Error("the server closed stdout"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the server did not answer"));
      }, timeoutMs);
      this.waiting.push((value) => {
        clearTimeout(timer);
        if (value === undefined) reject(new Error("the server closed stdout"));
        else resolve(value);
      });
    });
  }

  async stop(): Promise<void> {
    await this.reader.cancel();
  }
}

interface Child {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly lines: JsonLines;
  request(
    id: number,
    method: string,
    params?: unknown,
  ): Promise<Record<string, unknown>>;
  notify(method: string): void;
  close(): Promise<{ readonly out: string; readonly err: string; readonly code: number }>;
}

function start(home: string): Child {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "mcp"],
    cwd: home,
    env: { ...(process.env as Record<string, string>), OPERAD_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = new JsonLines(child.stdout);
  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    process: child,
    lines,
    async request(id, method, params) {
      send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      const line = await lines.next();
      return JSON.parse(line) as Record<string, unknown>;
    },
    notify(method) {
      send({ jsonrpc: "2.0", method });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [err, code] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { out: lines.seen.join("\n"), err, code };
      } finally {
        clearTimeout(timer);
        await lines.stop();
      }
    },
  };
}

function resultOf(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  }
  return result as Record<string, unknown>;
}

function structuredOf(response: Record<string, unknown>): Record<string, unknown> {
  const content = resultOf(response).structuredContent;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new Error(`expected structured content, got ${JSON.stringify(response)}`);
  }
  return content as Record<string, unknown>;
}

function errorOf(response: Record<string, unknown>): Record<string, unknown> {
  const error = response.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  }
  return error as Record<string, unknown>;
}

describe("operad mcp", () => {
  test("initializes, lists the table and reads every tool on fixture objects", async () => {
    const { home } = await makeHome();
    seed(home, "one", { title: "First", state: "new", note: "$1" });
    seed(home, "two", { title: "Second", state: "open" });
    const waitingRun = await addRun(home, "item:one", { prompt: "Approve?" });
    const runningRun = await addRun(home, "item:two", undefined);
    const child = start(home);
    try {
      const initialized = await child.request(1, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      });
      const init = resultOf(initialized);
      expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(init.capabilities).toEqual({ tools: {} });
      expect(init.serverInfo).toEqual({ name: "operad", version: "0.0.0" });
      expect(init.instructions).toBe(INSTRUCTIONS);
      expect(INSTRUCTIONS.split(". ")).toHaveLength(2);

      child.notify("notifications/initialized");
      const listed = await child.request(2, "tools/list", {});
      expect(resultOf(listed).tools).toEqual(TOOLS);

      const list = await child.request(3, "tools/call", {
        name: "list",
        arguments: { type: "item" },
      });
      const page = structuredOf(list);
      expect(page.rows).toMatchObject([
        { id: "one", title: "First", state: "new", note: "$1", waiting: true },
        { id: "two", title: "Second", state: "open", running: true },
      ]);
      const listText = (resultOf(list).content as { text: string }[])[0]?.text ?? "";
      expect(listText).toContain("| one | new | First | $1 | waiting |");

      const show = await child.request(4, "tools/call", {
        name: "show",
        arguments: { id: "item:one" },
      });
      const object = structuredOf(show);
      expect(object.row).toMatchObject({ id: "one", title: "First", waiting: true });
      expect(object.sections).toContainEqual({ id: "history", title: "History" });
      const actions = object.actions as {
        name: string;
        args?: { properties?: Record<string, unknown> };
        note?: string;
        noteRequired?: boolean;
        confirm?: boolean;
      }[];
      expect(actions.find((action) => action.name === "demo:approve")).toMatchObject({
        note: "note",
        noteRequired: true,
        confirm: false,
      });
      expect(actions.find((action) => action.name === "demo:drop")).toMatchObject({
        confirm: true,
      });

      const section = await child.request(5, "tools/call", {
        name: "section",
        arguments: { id: "item:one", section: "info" },
      });
      const content = structuredOf(section);
      expect(content.markdown).toContain("# Demo item");
      expect((resultOf(section).content as { text: string }[])[0]?.text).toBe(
        String(content.markdown),
      );

      const pending = await child.request(6, "tools/call", {
        name: "pending",
        arguments: {},
      });
      const pendingItems = resultOf(pending).structuredContent as unknown as {
        runId: string;
        prompt: string;
        actions: { plugin: string; action: string }[];
      }[];
      expect(pendingItems).toHaveLength(1);
      expect(pendingItems[0]).toMatchObject({
        runId: waitingRun,
        prompt: "Approve?",
      });
      expect(pendingItems[0]?.actions.map((action) => `${action.plugin}:${action.action}`)).toContain(
        "demo:approve",
      );

      const running = await child.request(7, "tools/call", {
        name: "running",
        arguments: {},
      });
      const runningItems = resultOf(running).structuredContent as unknown as {
        runId: string;
      }[];
      expect(runningItems.map((item) => item.runId)).toContain(runningRun);

      const history = await child.request(8, "tools/call", {
        name: "history",
        arguments: { id: "item:one" },
      });
      const historyResult = structuredOf(history);
      expect(historyResult.id).toBe("item:one");
      expect(historyResult.markdown).toContain("waiting for you");

      const unknownId = await child.request(9, "tools/call", {
        name: "show",
        arguments: { id: "item:nope" },
      });
      expect(resultOf(unknownId).isError).toBe(true);
      expect((resultOf(unknownId).content as { text: string }[])[0]?.text).toContain(
        'no object "item:nope"',
      );

      const unknownType = await child.request(10, "tools/call", {
        name: "list",
        arguments: { type: "nope" },
      });
      expect(resultOf(unknownType).isError).toBe(true);
      expect((resultOf(unknownType).content as { text: string }[])[0]?.text).toContain(
        'no loaded plugin shows objects of type "nope"',
      );

      const unknownSection = await child.request(11, "tools/call", {
        name: "section",
        arguments: { id: "item:one", section: "nope" },
      });
      expect(resultOf(unknownSection).isError).toBe(true);
      expect((resultOf(unknownSection).content as { text: string }[])[0]?.text).toContain(
        'has no section "nope"',
      );

      const malformed = await child.request(12, "tools/call", {
        name: "show",
        arguments: {},
      });
      expect(errorOf(malformed).code).toBe(-32602);
      expect(errorOf(malformed).message).toContain('missing required argument "id"');

      const unknownMethod = await child.request(13, "nope", {});
      expect(errorOf(unknownMethod).code).toBe(-32601);

      const ping = await child.request(14, "ping", {});
      expect(resultOf(ping)).toEqual({});
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }
  });

  test("writes only JSON-RPC to stdout when a view logs a failure", async () => {
    const { home } = await makeHome();
    seed(home, "async", { title: "Async", state: "new", mode: "async" });
    const child = start(home);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      const list = await child.request(2, "tools/call", {
        name: "list",
        arguments: { type: "item" },
      });
      const text = (resultOf(list).content as { text: string }[])[0]?.text ?? "";
      expect(text).toContain("error");
      expect(text).toContain("Promise");
    } finally {
      const closed = await child.close();
      for (const line of child.lines.seen) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      expect(closed.out).toContain('"jsonrpc":"2.0"');
      expect(closed.err).toContain("row failed");
      expect(closed.code).toBe(0);
    }
  });
});
