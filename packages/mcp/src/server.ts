/** The MCP stdio server: JSON-RPC framing, method dispatch and read tools. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, ViewError, cancelRun, createViews, defaultOperadHome, isRecord, listPending, loadPluginRegistry, messageOf, openConfigLog, openPluginStore, readConfig, recordAnswer, storeRootOf, type ActionInfo, type LogBackend, type OperadConfig, type PluginRegistry, type Views } from "@operad-io/engine";
import { InvalidToolArguments } from "./arguments.ts";
import { actionInfoNamed, actionMayRun, mcpPolicy } from "./policy.ts";
import {
  CHANNEL_CAPABILITY,
  CHANNEL_INSTRUCTIONS,
  CHANNEL_METHOD,
  startClaudeChannel,
  type ChannelHandle,
} from "./channel.ts";
import {
  TOOLS,
  runTool,
  toolError,
  validateArguments,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";
import type { ToolDefinition } from "./tools.ts";

/** The mcp package's own version, which the server reports to a client. */
export const MCP_VERSION = (() => {
  const manifest: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : "0.0.0";
})();

/** The MCP protocol version this server implements. */
export const PROTOCOL_VERSION = "2025-06-18";

/** What `initialize` tells a client when the owner allows no action. */
export const INSTRUCTIONS =
  "The operad MCP server reads objects, pending items and history, and writes the commands and lead actions it is allowed to. Owner decisions are not offered here.";

/** What `initialize` tells a client, following the configured allow lists. */
export function instructionsFor(
  mcp: OperadConfig["mcp"] | undefined,
  actions: readonly ActionInfo[] = [],
): string {
  const policy = mcpPolicy(mcp);
  // An action that asks for confirmation and is not in `confirmActions` is
  // refused when run, so it is not promised here.
  const runnable = (name: string): boolean => {
    const info = actionInfoNamed(actions, name);
    return info === undefined || actionMayRun(policy, info);
  };
  const allowed = [...policy.actions].filter(
    (name) => !policy.confirmActions.has(name) && runnable(name),
  );
  const confirmed = [...policy.confirmActions].filter(
    (name) => policy.actions.has(name) && runnable(name),
  );
  if (allowed.length === 0 && confirmed.length === 0) return INSTRUCTIONS;
  const names = [...allowed, ...confirmed].join(", ");
  return `The operad MCP server reads objects, pending items and history, and writes the commands it is allowed to. The owner's configuration lets the lead run these actions: ${names}. Every other action stays with the owner; show lists the ones it does not offer.`;
}

/** JSON-RPC error codes used by this server. */
export const RPC_ERRORS = {
  parse: -32700,
  request: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
} as const;

type JsonRpcId = string | number | null;

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** A stream-shaped input: a byte stream or text chunks. */
export interface McpInput extends AsyncIterable<Uint8Array | string> {}

/** Where the server reads and writes. Tests inject all three. */
export interface McpServerOptions {
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
  readonly input?: McpInput | undefined;
  readonly write?: ((text: string) => void | Promise<void>) | undefined;
  readonly error?: ((text: string) => void | Promise<void>) | undefined;
  readonly clock?: (() => number) | undefined;
  /** Declare Claude Code's channel capability and push object changes. */
  readonly claudeChannel?: boolean | undefined;
  /** The object types the channel reports; the default is every type with views. */
  readonly types?: readonly string[] | undefined;
}

interface OpenContext {
  readonly views: Views;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel: Kernel;
  readonly mcp: OperadConfig["mcp"];
  readonly cwd: string;
  readonly storeRoot: string;
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

function validId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    value === null
    ? value
    : undefined;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function lineWriter(
  write: (text: string) => void | Promise<void>,
): (response: JsonRpcResponse) => Promise<void> {
  return async (response) => {
    await write(`${JSON.stringify(response)}\n`);
  };
}

/** One writer, so a channel notification and a response never interleave. */
function serializedWrite(
  write: (text: string) => void | Promise<void>,
): (text: string) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (text) => {
    const next = tail.then(async () => {
      await write(text);
    });
    tail = next.catch(() => undefined);
    return next;
  };
}

function logWriter(
  error: (text: string) => void | Promise<void>,
): (message: string) => Promise<void> {
  return async (message) => {
    await error(`${message.replace(/\n?$/, "\n")}`);
  };
}

async function openContext(
  home: string,
  cwd: string,
  clock: () => number,
  onLog: (message: string) => void | Promise<void>,
): Promise<OpenContext> {
  const config: OperadConfig = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store = openPluginStore({
    backend: config.store.backend,
    root: storeRoot,
  });
  const log = openConfigLog(config);
  let loaded: PluginRegistry | undefined;
  const registry = await loadPluginRegistry({
    home,
    cwd,
    store,
    onCancelRun: (runId, graph) =>
      cancelRun({
        log,
        flow: (name) => loaded?.flow(name)?.flow,
        runId,
        graph,
        clock,
        source: "mcp",
      }),
    onAnswer: async (runId, choice, note, actor) => {
      await recordAnswer({
        log,
        runId,
        choice,
        ...(note === undefined ? {} : { note }),
        actor,
      });
    },
    onLog: (message) => {
      void onLog(message);
    },
  });
  loaded = registry;
  const views = createViews({
    registry,
    store,
    log,
    cwd,
    clock,
    onLog: (message) => {
      void onLog(message);
    },
  });
  const kernel = new Kernel({
    log,
    registry,
    home,
    storeRoot,
    clock,
    onLog: (message) => {
      void onLog(message);
    },
  });
  return { views, log, registry, kernel, mcp: config.mcp, cwd, storeRoot };
}

function toolContext(
  context: OpenContext,
  clock: () => number,
): ToolContext {
  return {
    views: context.views,
    log: context.log,
    registry: context.registry,
    kernel: context.kernel,
    clock,
    cwd: context.cwd,
    mcp: context.mcp,
  };
}

function requireEmptyParams(params: unknown): void {
  if (params === undefined || params === null) return;
  if (!isRecord(params) || Object.keys(params).length > 0) {
    throw new RpcError(RPC_ERRORS.params, "this method takes no parameters");
  }
}

function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

async function callTool(
  params: unknown,
  context: ToolContext,
): Promise<unknown> {
  if (!isRecord(params)) {
    throw new RpcError(RPC_ERRORS.params, "tools/call needs an object of parameters");
  }
  const name = params.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new RpcError(RPC_ERRORS.params, "tools/call needs a tool name");
  }
  const tool = toolByName(name);
  if (tool === undefined) {
    throw new RpcError(RPC_ERRORS.params, `unknown tool "${name}"`);
  }
  let args: Record<string, unknown>;
  try {
    args = validateArguments(
      tool.inputSchema,
      params.arguments === undefined ? {} : params.arguments,
    );
  } catch (error) {
    if (error instanceof InvalidToolArguments) {
      throw new RpcError(RPC_ERRORS.params, error.message);
    }
    throw error;
  }
  try {
    return await runTool(name, args, context);
  } catch (error) {
    if (error instanceof ViewError) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    throw error;
  }
}

async function dispatch(
  method: string,
  params: unknown,
  context: ToolContext,
  claudeChannel: boolean,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      if (params !== undefined && params !== null && !isRecord(params)) {
        throw new RpcError(RPC_ERRORS.params, "initialize needs an object of parameters");
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: claudeChannel
          ? {
              tools: {},
              experimental: { [CHANNEL_CAPABILITY]: {} },
            }
          : { tools: {} },
        serverInfo: { name: "operad", version: MCP_VERSION },
        instructions: claudeChannel
          ? `${instructionsFor(context.mcp, context.registry.actions())}\n\n${CHANNEL_INSTRUCTIONS}`
          : instructionsFor(context.mcp, context.registry.actions()),
      };
    case "ping":
      requireEmptyParams(params);
      return {};
    case "tools/list":
      requireEmptyParams(params);
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params, context);
    default:
      throw new RpcError(RPC_ERRORS.method, `no method "${method}"`);
  }
}

async function handleLine(
  line: string,
  context: ToolContext,
  send: (response: JsonRpcResponse) => Promise<void>,
  log: (message: string) => Promise<void>,
  claudeChannel: boolean,
  onInitialized: () => void,
): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    await send(failure(null, RPC_ERRORS.parse, "the line is not JSON"));
    return;
  }
  if (!isRecord(message)) {
    await send(failure(null, RPC_ERRORS.request, "the message must be an object"));
    return;
  }

  const givenId = message.id;
  const id = validId(givenId);
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (hasId && id === undefined)
  ) {
    await send(
      failure(id ?? null, RPC_ERRORS.request, "the message is not a JSON-RPC 2.0 request"),
    );
    return;
  }

  // A notification has no id and never gets a response, including an unknown
  // one. `notifications/initialized` is the only one MCP defines here, and it
  // lets the channel send what it held.
  if (!hasId) {
    if (message.method === "notifications/initialized") onInitialized();
    return;
  }
  if (id === undefined) return;

  try {
    const result = await dispatch(
      message.method,
      message.params,
      context,
      claudeChannel,
    );
    await send(success(id, result));
  } catch (error) {
    if (error instanceof RpcError) {
      await send(failure(id, error.code, error.message));
      return;
    }
    await log(`operad mcp: ${messageOf(error)}`);
    await send(
      failure(id, RPC_ERRORS.internal, "the request failed"),
    );
  }
}

async function* decodeLines(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of input) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (line.trim().length === 0) continue;
      yield line;
    }
  }
  buffer += decoder.decode();
  const last = buffer.replace(/\r$/, "");
  if (last.trim().length > 0) yield last;
}

/**
 * Runs the MCP server until stdin ends. It opens the configured home like a
 * command does, serves the presentation views and the allowed writes, and
 * never runs a step.
 */
export async function runMcpServer(
  options: McpServerOptions = {},
): Promise<void> {
  const home = options.home ?? defaultOperadHome();
  const cwd = options.cwd ?? process.cwd();
  const clock = options.clock ?? (() => Date.now());
  const write = serializedWrite(
    options.write ?? ((text: string) => void process.stdout.write(text)),
  );
  const error = options.error ?? ((text: string) => void process.stderr.write(text));
  const log = logWriter(error);
  const send = lineWriter(write);
  const input = options.input ?? Bun.stdin.stream();

  const opened = await openContext(home, cwd, clock, log);
  let channel: ChannelHandle | undefined;
  try {
    if (options.claudeChannel === true) {
      channel = await startClaudeChannel({
        views: opened.views,
        registry: opened.registry,
        log: opened.log,
        hold: true,
        notify: opened.mcp.channel.notify,
        loopAfter: opened.mcp.channel.loopAfter,
        pending: () =>
          listPending(
            opened.log,
            opened.registry,
            opened.kernel,
            opened.views,
            { withAuto: true },
          ),
        sentFile: join(
          home,
          `mcp-channel-${new Bun.CryptoHasher("sha1").update(opened.storeRoot).digest("hex").slice(0, 12)}.json`,
        ),
        ...(options.types === undefined ? {} : { types: options.types }),
        send: async (notification) => {
          await write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: CHANNEL_METHOD,
              params: notification,
            })}\n`,
          );
        },
        onLog: (message) => {
          void log(message);
        },
      });
    }
    const context = toolContext(opened, clock);
    for await (const line of decodeLines(input)) {
      await handleLine(line, context, send, log, channel !== undefined, () => {
        void channel?.release();
      });
    }
  } finally {
    await channel?.close();
    opened.views.close();
    await opened.log.close();
  }
}

/** The tools of the server, opened in this process for a harness that takes tools in-process. */
export interface McpTools {
  readonly tools: readonly ToolDefinition[];
  /** Runs one tool; a refusal of a view or a bad argument is an error result, never a throw. */
  call(name: string, args: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

/** What `openMcpTools` reads. */
export interface OpenMcpToolsOptions {
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
  readonly clock?: (() => number) | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

/**
 * Opens the home and offers the same tools `runMcpServer` serves, without the
 * protocol: the caller is a harness that registers them as its own tools.
 */
export async function openMcpTools(options: OpenMcpToolsOptions = {}): Promise<McpTools> {
  const home = options.home ?? defaultOperadHome();
  const clock = options.clock ?? (() => Date.now());
  const opened = await openContext(home, options.cwd ?? process.cwd(), clock, (message) => {
    options.onLog?.(message);
  });
  const context = toolContext(opened, clock);
  return {
    tools: TOOLS,
    async call(name, args) {
      const tool = toolByName(name);
      if (tool === undefined) return toolError(`unknown tool "${name}"`);
      try {
        const checked = validateArguments(tool.inputSchema, args === undefined ? {} : args);
        return await runTool(name, checked, context);
      } catch (error) {
        if (error instanceof ViewError || error instanceof InvalidToolArguments) {
          return toolError(error.message);
        }
        throw error;
      }
    },
    async close() {
      opened.views.close();
      await opened.log.close();
    },
  };
}
