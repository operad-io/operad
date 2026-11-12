/** The MCP tool table: names, input schemas and the one-line descriptions. */

import type {
  Kernel,
  LogBackend,
  McpConfig,
  PendingItem,
  PluginRegistry,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewSectionContent,
  Views,
} from "@operad-io/engine";
import {
  HISTORY_SECTION,
  listPending,
  listRunning,
  messageOf,
  ViewError,
  type Actor,
} from "@operad-io/engine";
import { machineLoad, type MachineLoad } from "@operad-io/engine/platform";
import { InvalidToolArguments, validateArguments } from "./arguments.ts";
import {
  historyMarkdown,
  listMarkdown,
  pendingMarkdown,
  runningMarkdown,
  sectionMarkdown,
  showMarkdown,
  valueText,
} from "./format.ts";
import {
  actionInfoNamed,
  actionMayRun,
  mcpPolicy,
  ownerRefusal,
  splitActions,
  splitPendingActions,
} from "./policy.ts";

/** The JSON Schema subset a tool input uses. */
export interface InputPropertySchema {
  readonly type?: "string" | "boolean" | "integer" | "array" | "object";
  readonly description?: string;
  readonly minLength?: number;
  readonly items?: InputPropertySchema;
}

/** A tool's input: an object with known properties only. */
export interface InputSchema {
  readonly type: "object";
  readonly required?: readonly string[];
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, InputPropertySchema>>;
}

/** One tool as `tools/list` serves it. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
}

/** Kernel command names; a plugin verb is never reachable through MCP. */
const KERNEL_VERBS = new Set([
  "init",
  "serve",
  "pending",
  "history",
  "running",
  "flows",
  "trigger",
  "list",
  "show",
  "plugin",
  "secret",
  "http",
  "pair",
  "run-internal",
  "mcp",
]);

/** The tools this server offers, in the order it lists them. */
export const TOOLS = [
  {
    name: "list",
    description: "List one object type, with the kernel's waiting and running flags.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          minLength: 1,
          description:
            "An object type, such as task. Optional with root or parent: then every type is listed.",
        },
        root: {
          type: "boolean",
          description: "Only rows with no parent.",
        },
        parent: {
          type: "string",
          minLength: 1,
          description: "Only rows whose parent is this object id.",
        },
        cursor: {
          type: "string",
          description: "The next cursor from an earlier list.",
        },
      },
    },
  },
  {
    name: "show",
    description: "Show one object's row, sections and available actions.",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          minLength: 1,
          description: "A bare id or type:id.",
        },
      },
    },
  },
  {
    name: "section",
    description: "Read one section of an object as Markdown.",
    inputSchema: {
      type: "object",
      required: ["id", "section"],
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          minLength: 1,
          description: "A bare id or type:id.",
        },
        section: {
          type: "string",
          minLength: 1,
          description: "A section id from show.",
        },
        cursor: {
          type: "string",
          description: "The next cursor from an earlier read.",
        },
        full: {
          type: "boolean",
          description: "Return the whole section without the size cap.",
        },
      },
    },
  },
  {
    name: "pending",
    description: "List the items waiting for a person, with their actions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "answer",
    description: "Answer one open question of a pending item by its wait id.",
    inputSchema: {
      type: "object",
      required: ["runId", "waitId", "choice"],
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "The pending item's runId.",
        },
        waitId: {
          type: "string",
          minLength: 1,
          description: "The pending item's waitId.",
        },
        choice: {
          type: "string",
          minLength: 1,
          description: "One of the item's choices.",
        },
        note: {
          type: "string",
          description: "The note, when the question asks for one.",
        },
        confirmed: {
          type: "boolean",
          description:
            "Set when the answer is a choice whose action asks to confirm.",
        },
      },
    },
  },
  {
    name: "running",
    description:
      "List the runs in progress, with the machine's 1-minute load average and core count.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "history",
    description: "Read the history section of one object.",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          minLength: 1,
          description: "A bare id or type:id.",
        },
      },
    },
  },
  {
    name: "command",
    description: "Run a plugin verb the way the CLI does.",
    inputSchema: {
      type: "object",
      required: ["plugin", "verb"],
      additionalProperties: false,
      properties: {
        plugin: {
          type: "string",
          minLength: 1,
          description: "A loaded plugin name, such as dev.",
        },
        verb: {
          type: "string",
          minLength: 1,
          description: "A verb the plugin declares, such as plan.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "The command-line arguments after the verb.",
        },
        input: {
          type: "string",
          description: "The text the CLI reads from stdin, such as a brief.",
        },
      },
    },
  },
  {
    name: "act",
    description: "Run an action the MCP server is allowed to run for a lead.",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          minLength: 1,
          description: "A <plugin>:<action> name from show.",
        },
        id: {
          type: "string",
          description: "The object id when the action targets one.",
        },
        args: {
          type: "object",
          description: "The action's arguments, as its schema names them.",
        },
        note: {
          type: "string",
          description: "The note for an action whose schema declares one.",
        },
      },
    },
  },
] as const satisfies readonly ToolDefinition[];

/** One text block of a tool result. */
export interface ToolTextContent {
  readonly type: "text";
  readonly text: string;
}

/** A successful tool result, or a view refusal with `isError`. */
export interface ToolResult {
  readonly content: readonly ToolTextContent[];
  /** MCP requires an object here, never a list: a list is wrapped as `{ items }`. */
  readonly structuredContent?: object;
  readonly isError?: true;
}

/** What a tool call reads; all of it is the presentation kernel's own view. */
export interface ToolContext {
  readonly views: Views;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel: Kernel;
  readonly clock: () => number;
  readonly cwd?: string | undefined;
  readonly mcp?: McpConfig | undefined;
  /** Reads the machine load; tests inject it. */
  readonly load?: (() => MachineLoad) | undefined;
}

function text(value: string): ToolTextContent {
  return { type: "text", text: value };
}

/** The error result a view refusal becomes: the view's message, and no stack. */
export function toolError(message: string): ToolResult {
  return {
    content: [text(message)],
    isError: true,
  };
}

/**
 * A plugin verb's value as MCP structured content: a plain object as it is,
 * anything else (a list, a string, a number) wrapped as `{ value }`.
 */
function structuredValue(value: unknown): object {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return { value };
}

/**
 * Runs one read tool. The arguments are already checked against the table's
 * input schema by the caller.
 */
export async function runTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "list": {
      const type = args.type === undefined ? undefined : String(args.type);
      const root = args.root === true;
      const parent = args.parent === undefined ? undefined : String(args.parent);
      if (type === undefined && !root && parent === undefined) {
        throw new ViewError("args", "list needs a type, root or parent");
      }
      const level = {
        ...(root ? { root } : {}),
        ...(parent === undefined ? {} : { parent }),
        ...(args.cursor === undefined ? {} : { cursor: String(args.cursor) }),
      };
      const page: ViewListPage =
        root || parent !== undefined
          ? await context.views.listTree(type, level)
          : await context.views.list(String(type), level);
      return {
        content: [text(listMarkdown(page))],
        structuredContent: page,
      };
    }
    case "show": {
      const object: ViewObject = await context.views.get(String(args.id));
      const shown = splitActions(object, mcpPolicy(context.mcp));
      return {
        content: [text(showMarkdown(shown))],
        structuredContent: shown,
      };
    }
    case "section": {
      const content: ViewSectionContent = await context.views.section(
        String(args.id),
        String(args.section),
        args.cursor === undefined ? undefined : String(args.cursor),
        { full: args.full === true },
      );
      return {
        content: [text(sectionMarkdown(content))],
        structuredContent: content,
      };
    }
    case "pending": {
      const pending: readonly PendingItem[] = await listPending(
        context.log,
        context.registry,
        context.kernel,
        context.views,
      );
      const shown = splitPendingActions(
        pending,
        context.registry.actions(),
        mcpPolicy(context.mcp),
      );
      return {
        content: [text(pendingMarkdown(shown))],
        structuredContent: { items: shown },
      };
    }
    case "answer": {
      const runId = String(args.runId);
      const waitId = String(args.waitId);
      const choice = String(args.choice);
      const note = args.note === undefined ? undefined : String(args.note);
      const actor: Actor = { via: "mcp", id: "lead" };
      const pending = await listPending(
        context.log,
        context.registry,
        context.kernel,
        context.views,
      );
      const item = pending.find(
        (candidate) => candidate.runId === runId && candidate.waitId === waitId,
      );
      // A wait whose choices are the object's actions answers through that
      // action, so its confirmation and the owner's allow list still apply.
      const throughAction =
        item !== undefined &&
        item.choices.every((name) =>
          item.actions.some((action) => action.action === name),
        )
          ? item.actions.find((action) => action.action === choice)
          : undefined;
      if (item !== undefined && throughAction !== undefined) {
        const info = actionInfoNamed(
          context.registry.actions(),
          `${throughAction.plugin}:${throughAction.action}`,
        );
        if (info === undefined) {
          return toolError(`there is no action "${throughAction.action}"`);
        }
        if (!actionMayRun(mcpPolicy(context.mcp), info)) {
          return toolError(ownerRefusal(info.name));
        }
        if (item.object === undefined) {
          return toolError(`the pending item "${waitId}" names no object`);
        }
        try {
          const run = await context.views.act(info.name, item.object, {
            args: {},
            ...(note === undefined ? {} : { note }),
            yes: args.confirmed === true,
            actor,
          });
          return {
            content: [text(valueText(run.value) || `ran "${run.name}"\n`)],
            structuredContent: run,
          };
        } catch (error) {
          return toolError(messageOf(error));
        }
      }
      const result = {
        runId,
        waitId,
        choice,
        ...(note === undefined ? {} : { note }),
      };
      try {
        await context.views.answer({
          runId,
          waitId,
          choice,
          ...(note === undefined ? {} : { note }),
          ...(args.confirmed === true ? { confirmed: true } : {}),
          actor,
        });
        return {
          content: [text(`answered ${waitId}\n`)],
          structuredContent: result,
        };
      } catch (error) {
        return toolError(messageOf(error));
      }
    }
    case "running": {
      const running: readonly RunningItem[] = await listRunning(
        context.log,
        context.clock,
        context.views,
      );
      const load = (context.load ?? machineLoad)();
      return {
        content: [text(runningMarkdown(running, load))],
        structuredContent: { items: running, load },
      };
    }
    case "history": {
      const id = String(args.id);
      const content = await context.views.section(id, HISTORY_SECTION);
      const result = { id, ...content };
      return {
        content: [text(historyMarkdown(result))],
        structuredContent: result,
      };
    }
    case "command": {
      const plugin = String(args.plugin);
      const verb = String(args.verb);
      if (KERNEL_VERBS.has(plugin)) {
        return toolError(
          `"${plugin}" is a kernel verb; it is not reachable through MCP`,
        );
      }
      const commandArgs = Array.isArray(args.args)
        ? args.args.map((item) => String(item))
        : [];
      const argv = [plugin, verb, ...commandArgs];
      const resolved = context.registry.resolveCommand(argv);
      if (
        resolved === undefined ||
        resolved.plugin !== plugin ||
        resolved.command !== verb
      ) {
        if (KERNEL_VERBS.has(verb)) {
          return toolError(
            `"${verb}" is a kernel verb; it is not reachable through MCP`,
          );
        }
        return toolError(
          `no loaded plugin "${plugin}" declares the verb "${verb}"`,
        );
      }
      try {
        const run = await context.registry.runCommand(
          argv,
          {
            ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
            input: args.input === undefined ? "" : String(args.input),
          },
        );
        if (run === undefined) {
          return toolError(
            `no loaded plugin "${plugin}" declares the verb "${verb}"`,
          );
        }
        return {
          content: [text(valueText(run.value))],
          structuredContent: structuredValue(run.value),
        };
      } catch (error) {
        return toolError(messageOf(error));
      }
    }
    case "act": {
      const policy = mcpPolicy(context.mcp);
      const action = String(args.action);
      const info = actionInfoNamed(context.registry.actions(), action);
      if (info === undefined) {
        return toolError(`there is no action "${action}"`);
      }
      if (!actionMayRun(policy, info)) {
        return toolError(ownerRefusal(info.name));
      }
      const actionArgs =
        args.args !== undefined && typeof args.args === "object" && args.args !== null
          ? (args.args as Readonly<Record<string, unknown>>)
          : {};
      const actor: Actor = { via: "mcp", id: "lead" };
      try {
        const run = await context.views.act(info.name, args.id === undefined ? undefined : String(args.id), {
          args: actionArgs,
          ...(args.note === undefined ? {} : { note: String(args.note) }),
          yes: info.confirm,
          actor,
        });
        return {
          content: [text(valueText(run.value) || `ran "${run.name}"\n`)],
          structuredContent: run,
        };
      } catch (error) {
        return toolError(messageOf(error));
      }
    }
    default:
      throw new InvalidToolArguments(`unknown tool "${name}"`);
  }
}

export { validateArguments };
