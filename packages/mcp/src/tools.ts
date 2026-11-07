/** The MCP tool table: names, input schemas and the one-line descriptions. */

import type {
  Kernel,
  LogBackend,
  PendingItem,
  PluginRegistry,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewSectionContent,
  Views,
} from "@operad-io/engine";
import { HISTORY_SECTION, listPending, listRunning } from "@operad-io/engine";
import { InvalidToolArguments, validateArguments } from "./arguments.ts";
import {
  historyMarkdown,
  listMarkdown,
  pendingMarkdown,
  runningMarkdown,
  sectionMarkdown,
  showMarkdown,
} from "./format.ts";

/** The JSON Schema subset a tool input uses. */
export interface InputPropertySchema {
  readonly type?: "string" | "boolean" | "integer";
  readonly description?: string;
  readonly minLength?: number;
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
      return {
        content: [text(showMarkdown(object))],
        structuredContent: object,
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
    default:
      throw new InvalidToolArguments(`unknown tool "${name}"`);
  }
}

export { validateArguments };
