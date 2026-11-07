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
  type Actor,
} from "@operad-io/engine";
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
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          minLength: 1,
          description: "An object type, such as task.",
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
    name: "running",
    description: "List the runs in progress.",
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
  readonly structuredContent?: unknown;
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
      const type = String(args.type);
      const page: ViewListPage = await context.views.list(type, {
        ...(args.cursor === undefined ? {} : { cursor: String(args.cursor) }),
      });
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
      );
      return {
        content: [text(pendingMarkdown(pending))],
        structuredContent: pending,
      };
    }
    case "running": {
      const running: readonly RunningItem[] = await listRunning(
        context.log,
        context.clock,
      );
      return {
        content: [text(runningMarkdown(running))],
        structuredContent: running,
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
      if (KERNEL_VERBS.has(plugin) || KERNEL_VERBS.has(verb)) {
        return toolError(
          `"${KERNEL_VERBS.has(plugin) ? plugin : verb}" is a kernel verb; it is not reachable through MCP`,
        );
      }
      const commandArgs = Array.isArray(args.args)
        ? args.args.map((item) => String(item))
        : [];
      try {
        const run = await context.registry.runCommand(
          [plugin, verb, ...commandArgs],
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
          structuredContent: run.value,
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
        return toolError(`no loaded plugin declares action "${action}"`);
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
