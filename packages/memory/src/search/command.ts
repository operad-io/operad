/**
 * `memory search` and `memory read`: the verbs behind the operad tools a bot
 * gets. Both refresh the index first, so a file another process wrote and a
 * chat that just gained a message are found without a watcher having to catch
 * up. A caller may give the arguments as JSON on stdin (the MCP tools do) or as
 * words on the command line.
 */

import { isRecord, type CommandContext } from "@operad-io/engine";
import {
  fieldFiltersOf,
  openMemorySearch,
  requestedLimit,
  requestedScopes,
} from "./service.ts";
import {
  SEARCH_SCOPES,
  SearchError,
  type Backlink,
  type ReadResult,
  type SearchScope,
} from "./types.ts";

function textOf(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SearchError(`${name} must be text`);
  }
  return value;
}

function scopesOf(value: unknown): readonly SearchScope[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) throw new SearchError("scope must be one of wiki, memory or chats");
  const found: SearchScope[] = [];
  for (const item of list) {
    const name = String(item).trim();
    if (name.length === 0) continue;
    const scope = SEARCH_SCOPES.find((candidate) => candidate === name);
    if (scope === undefined) throw new SearchError(`unknown scope "${name}"`);
    if (!found.includes(scope)) found.push(scope);
  }
  return found.length === 0 ? undefined : found;
}

function limitOf(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number)) throw new SearchError("limit must be a whole number");
  return requestedLimit(number);
}

function jsonInput(input: string | undefined): Record<string, unknown> | undefined {
  const text = input?.trim() ?? "";
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SearchError(`the search arguments are not JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) throw new SearchError("the search arguments must be a JSON object");
  return parsed;
}

interface SearchInput {
  readonly query: string;
  readonly scopes?: readonly SearchScope[] | undefined;
  readonly fields?: Readonly<Record<string, string | readonly string[]>> | undefined;
  readonly limit?: number | undefined;
  /** Only from the command line: the tools a bot gets cannot reach into another chat. */
  readonly chat?: string | undefined;
}

function searchFromJson(parsed: Record<string, unknown>): SearchInput {
  const query = textOf(parsed["query"] ?? parsed["text"], "query");
  const scopes = scopesOf(parsed["scope"] ?? parsed["scopes"]);
  const fields = parsed["fields"] === undefined ? undefined : fieldFiltersOf(parsed["fields"]);
  const limit = limitOf(parsed["limit"]);
  return { query, ...(scopes === undefined ? {} : { scopes }), ...(fields === undefined ? {} : { fields }), ...(limit === undefined ? {} : { limit }) };
}

function searchFromArgv(argv: readonly string[]): SearchInput {
  const words: string[] = [];
  const scopes: string[] = [];
  const fields: Record<string, string> = {};
  let limit: string | undefined;
  let chat: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--chat" || arg.startsWith("--chat=")) {
      chat = arg === "--chat" ? argv[++index] ?? "" : arg.slice("--chat=".length);
      if (chat.length === 0) throw new SearchError("--chat takes a chat id");
      continue;
    }
    if (arg === "--scope" || arg.startsWith("--scope=")) {
      const value = arg === "--scope" ? argv[++index] ?? "" : arg.slice("--scope=".length);
      scopes.push(value);
      continue;
    }
    if (arg === "--field" || arg.startsWith("--field=")) {
      const value = arg === "--field" ? argv[++index] ?? "" : arg.slice("--field=".length);
      const at = value.indexOf("=");
      if (at <= 0) throw new SearchError("--field takes <name>=<value>");
      fields[value.slice(0, at)] = value.slice(at + 1);
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      limit = arg === "--limit" ? argv[++index] ?? "" : arg.slice("--limit=".length);
      continue;
    }
    if (arg.startsWith("--")) throw new SearchError(`search does not take "${arg}"`);
    words.push(arg);
  }
  if (words.length === 0) throw new SearchError("search needs a query");
  return {
    query: words.join(" "),
    ...(scopes.length === 0 ? {} : { scopes: scopesOf(scopes) }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(limit === undefined ? {} : { limit: limitOf(limit) }),
    ...(chat === undefined ? {} : { chat }),
  };
}

function searchInput(ctx: CommandContext, argv: readonly string[]): SearchInput {
  const parsed = jsonInput(ctx.input);
  return parsed === undefined ? searchFromArgv(argv) : searchFromJson(parsed);
}

interface ReadInput {
  readonly id: string;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly json: boolean;
}

function lineNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new SearchError(`${name} must be a whole line number above zero`);
  return number;
}

function readInput(ctx: CommandContext, argv: readonly string[]): ReadInput {
  const parsed = jsonInput(ctx.input);
  if (parsed !== undefined) {
    return {
      id: textOf(parsed["id"], "id"),
      ...(parsed["from"] === undefined ? {} : { from: lineNumber(parsed["from"], "from") }),
      ...(parsed["to"] === undefined ? {} : { to: lineNumber(parsed["to"], "to") }),
      json: true,
    };
  }
  const words: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else words.push(arg);
  }
  const id = words[0];
  if (id === undefined || id.length === 0) throw new SearchError("read needs a document id");
  return {
    id,
    ...(words[1] === undefined ? {} : { from: lineNumber(words[1], "from") }),
    ...(words[2] === undefined ? {} : { to: lineNumber(words[2], "to") }),
    json,
  };
}

/** One backlink as a line a reader can follow. */
function backlinkLine(entry: Backlink): string {
  const line = entry.line > 0 ? ` line ${entry.line}` : "";
  const mark = entry.untrusted ? " (untrusted)" : "";
  const excerpt = entry.excerpt.length > 0 ? ` — ${entry.excerpt}` : "";
  return `- \`${entry.path}\`${line}${mark}${excerpt}`;
}

/** One document as the command prints it, ending with its backlinks. */
export function readText(result: ReadResult): string {
  const lines = [`# ${result.title}`, ""];
  lines.push(`- id: \`${result.id}\``);
  if (result.path !== undefined) lines.push(`- path: ${result.path}`);
  lines.push(`- lines: ${result.lineStart}-${result.lineEnd} of ${result.totalLines}`);
  if (result.text.length > 0) lines.push("", result.text);
  if (result.backlinks.length > 0) {
    lines.push("", "## Backlinks");
    for (const entry of result.backlinks) lines.push(backlinkLine(entry));
  }
  return `${lines.join("\n")}\n`;
}

/** The `memory search` verb. */
export async function runMemorySearch(ctx: CommandContext, argv: readonly string[]): Promise<unknown> {
  const input = searchInput(ctx, argv);
  const search = openMemorySearch(ctx.home, ctx.settings);
  try {
    await search.refresh(ctx.store);
    return search.search({
      text: input.query,
      cwd: ctx.cwd,
      ...(input.scopes === undefined ? {} : { scopes: requestedScopes(input.scopes) }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.chat === undefined ? {} : { chat: input.chat, store: ctx.store }),
    });
  } finally {
    search.close();
  }
}

/** The `memory read` verb: one document, or the line range asked for. */
export async function runMemoryRead(ctx: CommandContext, argv: readonly string[]): Promise<unknown> {
  const input = readInput(ctx, argv);
  const search = openMemorySearch(ctx.home, ctx.settings);
  try {
    await search.refresh(ctx.store);
    const result = search.read({
      id: input.id,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    return input.json ? result : readText(result);
  } finally {
    search.close();
  }
}
