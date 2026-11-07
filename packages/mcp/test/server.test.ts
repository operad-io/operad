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
const devPluginPath = fileURLToPath(
  new URL("../../dev/src/index.ts", import.meta.url),
);
const kernelCommandPluginPath = fileURLToPath(
  new URL("./fixtures/kernel-command.ts", import.meta.url),
);

interface Home {
  readonly root: string;
  readonly home: string;
}

async function makeHome(extra: Record<string, unknown> = {}): Promise<Home> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
      ...extra,
    }),
  );
  return { root, home };
}

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

function makeRepository(root: string): string {
  const repository = join(root, "repo");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q"]);
  git(repository, ["remote", "add", "origin", "https://example.com/repo.git"]);
  git(repository, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "start",
  ]);
  return repository;
}

async function makeDevHome(
  extra: Record<string, unknown> = {},
): Promise<Home & { readonly repository: string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const repository = makeRepository(root);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [devPluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
      ...extra,
    }),
  );
  return { root, home, repository };
}

function pluginStoreRoot(home: string): string {
  return join(home, "..", "store", "plugins");
}

function taskKey(id: string): string {
  return `repo/${id}`;
}

function patchTask(
  home: string,
  id: string,
  change: Record<string, unknown>,
): void {
  const store = new FilePluginStore({ root: pluginStoreRoot(home) });
  const key = taskKey(id);
  const current = store.get("task", key);
  if (current === undefined) throw new Error(`no task "${key}"`);
  store.put("task", key, { ...current.data, ...change }, "test");
}

function taskData(home: string, id: string): Record<string, unknown> {
  const store = new FilePluginStore({ root: pluginStoreRoot(home) });
  const task = store.get("task", taskKey(id));
  if (task === undefined) throw new Error(`no task "${taskKey(id)}"`);
  return task.data;
}

function seed(home: string, id: string, data: Record<string, unknown>): void {
  const root = join(home, "..", "store", "plugins");
  new FilePluginStore({ root }).put("item", id, data, "seed");
}

async function addRun(
  home: string,
  object: string,
  waiting: { readonly prompt: string } | undefined,
  choices: readonly string[] = ["yes"],
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
            choices: [...choices],
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

function start(home: string, cwd = home): Child {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "mcp"],
    cwd,
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

function textOf(response: Record<string, unknown>): string {
  const content = resultOf(response).content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
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
    const { home } = await makeHome({
      mcp: {
        actions: ["demo:approve", "demo:drop"],
        confirmActions: ["demo:drop"],
      },
    });
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
  test("splits show actions into the lead's and the owner's", async () => {
    const { home } = await makeHome({
      mcp: {
        actions: ["demo:approve", "demo:drop"],
        confirmActions: [],
      },
    });
    seed(home, "one", { title: "First", state: "new" });
    const child = start(home);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      const shown = await child.request(2, "tools/call", {
        name: "show",
        arguments: { id: "item:one" },
      });
      const object = structuredOf(shown);
      const actions = object.actions as { name: string }[];
      expect(actions.map((action) => action.name)).toEqual(["demo:approve"]);
      expect(object.ownerActions).toEqual([
        "demo:auto",
        "demo:label",
        "demo:drop",
      ]);
      expect(textOf(shown)).toContain("## Owner actions");
      expect(textOf(shown)).toContain("demo:drop");
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }
  });

  test("pending lists only the actions the lead may run", async () => {
    const { home } = await makeHome({
      mcp: {
        actions: ["demo:approve", "demo:drop"],
        confirmActions: [],
      },
    });
    seed(home, "one", { title: "First", state: "new" });
    await addRun(home, "item:one", { prompt: "Approve?" });
    const child = start(home);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      const pending = await child.request(2, "tools/call", {
        name: "pending",
        arguments: {},
      });
      const items = resultOf(pending).structuredContent as unknown as {
        actions: { plugin: string; action: string }[];
      }[];
      expect(items[0]?.actions).toEqual([
        { plugin: "demo", action: "approve" },
      ]);
      expect(textOf(pending)).toContain("- actions: demo:approve");
      expect(textOf(pending)).not.toContain("demo:drop");
      expect(textOf(pending)).not.toContain("demo:auto");
      expect(textOf(pending)).not.toContain("demo:label");
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }
  });

  test("command runs plugin verbs with input and refuses a kernel verb", async () => {
    const { home, repository } = await makeDevHome();
    const child = start(home, repository);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      const added = await child.request(2, "tools/call", {
        name: "command",
        arguments: { plugin: "dev", verb: "repo", args: ["add", "."] },
      });
      expect(resultOf(added).isError).toBeUndefined();
      expect(textOf(added)).toContain("added repo");

      const plan = await child.request(3, "tools/call", {
        name: "command",
        arguments: {
          plugin: "dev",
          verb: "plan",
          args: ["add", "--slug", "alpha", "--title", "Alpha"],
          input: "Do the thing.\n",
        },
      });
      expect(textOf(plan).trim()).toBe("P-0001-alpha");

      const task = await child.request(4, "tools/call", {
        name: "command",
        arguments: {
          plugin: "dev",
          verb: "task",
          args: [
            "add",
            "--plan",
            "P-0001-alpha",
            "--slug",
            "first",
            "--title",
            "First task",
          ],
          input: "# Brief\n\nUse the store.\n",
        },
      });
      expect(textOf(task).trim()).toBe("T-0001-first");

      const brief = await child.request(5, "tools/call", {
        name: "section",
        arguments: { id: "T-0001-first", section: "brief" },
      });
      expect(textOf(brief)).toContain("Use the store.");

      const kernel = await child.request(6, "tools/call", {
        name: "command",
        arguments: { plugin: "serve", verb: "start" },
      });
      expect(resultOf(kernel).isError).toBe(true);
      expect(textOf(kernel)).toContain("serve");
      expect(textOf(kernel)).toContain("kernel verb");
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }
  });

  test("command runs a plugin verb whose name is also a kernel verb", async () => {
    const { home } = await makeHome({ plugins: [kernelCommandPluginPath] });
    const child = start(home);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      const shown = await child.request(2, "tools/call", {
        name: "command",
        arguments: { plugin: "echo", verb: "show", args: ["hello"] },
      });
      expect(resultOf(shown).isError).toBeUndefined();
      expect(textOf(shown).trim()).toBe("plugin show: hello");
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }
  });

  test("act runs a lead rework with the mcp lead actor and refuses merge by default", async () => {
    const { home, repository } = await makeDevHome();
    const child = start(home, repository);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      await child.request(2, "tools/call", {
        name: "command",
        arguments: { plugin: "dev", verb: "repo", args: ["add", "."] },
      });
      await child.request(3, "tools/call", {
        name: "command",
        arguments: {
          plugin: "dev",
          verb: "plan",
          args: ["add", "--slug", "alpha", "--title", "Alpha"],
          input: "Do the thing.\n",
        },
      });
      const task = await child.request(4, "tools/call", {
        name: "command",
        arguments: {
          plugin: "dev",
          verb: "task",
          args: [
            "add",
            "--plan",
            "P-0001-alpha",
            "--slug",
            "first",
            "--title",
            "First task",
          ],
          input: "# Brief\n",
        },
      });
      expect(textOf(task).trim()).toBe("T-0001-first");
      patchTask(home, "T-0001-first", { phase: "waiting" });
      await addRun(
        home,
        `task:${taskKey("T-0001-first")}`,
        { prompt: "Ready?" },
        ["merge", "reject", "rework", "reverify"],
      );

      const rework = await child.request(5, "tools/call", {
        name: "act",
        arguments: {
          action: "dev:rework",
          id: "T-0001-first",
          note: "cover the empty case",
        },
      });
      expect(resultOf(rework).isError).toBeUndefined();
      expect((structuredOf(rework).action as string)).toBe("rework");

      const merge = await child.request(6, "tools/call", {
        name: "act",
        arguments: { action: "dev:merge", id: "T-0001-first" },
      });
      expect(resultOf(merge).isError).toBe(true);
      expect(textOf(merge)).toContain("dev:merge");
      expect(textOf(merge)).toContain("owner");
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }

    const after = taskData(home, "T-0001-first");
    expect(after.phase).toBe("running");
    expect(String(after.brief)).toContain("cover the empty case");
    const store = new FilePluginStore({ root: pluginStoreRoot(home) });
    const invoked = store.facts().find((fact) => fact.type === "action_invoked");
    expect(invoked?.data.actor).toEqual({ via: "mcp", id: "lead" });
  });

  test("a confirm action runs when both MCP lists name it", async () => {
    const { home, repository } = await makeDevHome({
      mcp: {
        actions: ["dev:merge"],
        confirmActions: ["dev:merge"],
      },
    });
    const child = start(home, repository);
    try {
      await child.request(1, "initialize", { protocolVersion: PROTOCOL_VERSION });
      await child.request(2, "tools/call", {
        name: "command",
        arguments: { plugin: "dev", verb: "repo", args: ["add", "."] },
      });
      await child.request(3, "tools/call", {
        name: "command",
        arguments: {
          plugin: "dev",
          verb: "plan",
          args: ["add", "--slug", "alpha", "--title", "Alpha"],
          input: "Do the thing.\n",
        },
      });
      await child.request(4, "tools/call", {
        name: "command",
        arguments: {
          plugin: "dev",
          verb: "task",
          args: [
            "add",
            "--plan",
            "P-0001-alpha",
            "--slug",
            "first",
            "--title",
            "First task",
          ],
          input: "# Brief\n",
        },
      });
      patchTask(home, "T-0001-first", {
        phase: "waiting",
        attempt: { number: 1, run: "run-1", worktree: "/tmp/none", verified: "abc123" },
      });
      const runId = await addRun(
        home,
        `task:${taskKey("T-0001-first")}`,
        { prompt: "Ready?" },
        ["merge", "reject"],
      );

      const merge = await child.request(5, "tools/call", {
        name: "act",
        arguments: { action: "dev:merge", id: "T-0001-first" },
      });
      expect(resultOf(merge).isError).toBeUndefined();
      expect(structuredOf(merge).name).toBe("dev:merge");

      const log = openConfigLog(await readConfig(home));
      try {
        const answer = await (async () => {
          for await (const input of log.readInputs()) {
            if (input.runId === runId && input.source === "person") return input;
          }
          return undefined;
        })();
        expect(answer?.payload).toMatchObject({
          kind: "person_answer",
          choice: "merge",
          actor: { via: "mcp", id: "lead" },
        });
      } finally {
        await log.close();
      }
    } finally {
      const closed = await child.close();
      expect(closed.code).toBe(0);
    }
    expect(String(taskData(home, "T-0001-first").brief)).toContain(
      "merge requested",
    );
  });

});
