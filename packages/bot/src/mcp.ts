/**
 * Local MCP servers of a bot: what registering one takes (a command with
 * arguments, or a pasted `mcpServers` entry of that form), the version pin, the
 * digest of a tool list and the difference between two lists. A server is
 * registered through a proposal a person approves (`proposals.ts`); the guard
 * (`guard.ts`) stands in front of it when a chat starts it.
 */

import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { isRecord } from "@operad-io/engine";
import { MCP_REPORT_DIR } from "./mcp-constants.ts";
import { BotError, type McpServerSettings } from "./bot.ts";
import type { McpTool } from "./mcp-client.ts";

export { MCP_REPORT_DIR };

/** The directory of the reports of a home. */
export function reportDirectory(home: string): string {
  return join(home, MCP_REPORT_DIR);
}

/** The name of a secret a server needs: the plugin's own secret store keeps it. */
export function secretName(server: string, variable: string): string {
  return `${server}.${variable}`;
}

const SERVER_NAME = /^[a-z0-9][a-z0-9-]*(?:_[a-z0-9-]+)*$/;

/** Checks the name a server goes by in a chat: its tools are `mcp__<name>__<tool>`. */
export function validateServerName(name: string): void {
  if (!SERVER_NAME.test(name) || name.includes("__")) {
    throw new BotError(
      `MCP server "${name}": a name is lowercase letters, digits and "-", with single "_" between parts`,
    );
  }
  if (name === "operad") throw new BotError('MCP server "operad" is operad\'s own; use another name');
}

/** The digest of a tool list: names and descriptions only, in name order. */
export function toolDigest(tools: readonly McpTool[]): string {
  const sorted = [...tools]
    .map((tool) => ({ name: tool.name, description: tool.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}

/** What was registered: the command as the person wrote it, and the variables the server needs. */
export interface McpRegistration {
  readonly command: string;
  readonly args: readonly string[];
  /** Names of the environment variables the server needs; the values are never kept. */
  readonly variables: readonly string[];
  /** Values given with the registration (a pasted `env`); used to read the tool list once, then dropped. */
  readonly given: Readonly<Record<string, string>>;
}

/** Reads the pasted text of a registration: an `mcpServers` map or one entry of the command form. */
export function parsePasted(text: string, name: string): McpRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BotError("the pasted server is not JSON; paste an mcpServers entry such as {\"command\": \"npx\", \"args\": [\"-y\", \"pkg@1.2.3\"]}");
  }
  if (!isRecord(parsed)) throw new BotError("the pasted server must be a JSON object");
  let entry: unknown = parsed;
  if (isRecord(parsed.mcpServers)) {
    const entries = Object.entries(parsed.mcpServers);
    const named = parsed.mcpServers[name];
    if (named !== undefined) entry = named;
    else if (entries.length === 1) entry = entries[0]?.[1];
    else throw new BotError(`the pasted mcpServers holds ${entries.length} servers and none is called "${name}"`);
  }
  if (!isRecord(entry)) throw new BotError("the pasted server must be a JSON object");
  if (entry.url !== undefined || entry.type === "http" || entry.type === "sse" || entry.headers !== undefined) {
    throw new BotError("a remote server (an address) cannot be registered yet; only a local one, a command with arguments");
  }
  if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
    throw new BotError("the pasted server needs a command");
  }
  const args = entry.args === undefined ? [] : entry.args;
  if (!Array.isArray(args) || !args.every((item): item is string => typeof item === "string")) {
    throw new BotError("the pasted server's args must be a list of text");
  }
  const given: Record<string, string> = {};
  if (entry.env !== undefined) {
    if (!isRecord(entry.env)) throw new BotError("the pasted server's env must be an object");
    for (const [key, value] of Object.entries(entry.env)) {
      if (typeof value !== "string") throw new BotError(`the pasted server's env "${key}" must be text`);
      given[key] = value;
    }
  }
  return { command: entry.command, args, variables: Object.keys(given), given };
}

/** What a command says about its package. */
export interface PackageRef {
  readonly package: string;
  readonly version: string;
}

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const NPM_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PYTHON_RUNNERS = new Set(["uvx", "pipx"]);
/** Flags of the runners that take a value: the package would then be named in a form not read here. */
const FLAGS_WITH_PACKAGE = new Set(["-p", "--package", "-c", "--call", "--from", "--with"]);

function floating(spec: string, why: string, name: string): BotError {
  return new BotError(
    `"${spec}" is not pinned (${why}). Pin an exact version so what runs cannot change under you, for example ${name}@1.2.3`,
  );
}

function packageOf(spec: string, python: boolean): PackageRef {
  let name: string;
  let version: string;
  const equals = python ? spec.indexOf("==") : -1;
  if (equals > 0) {
    name = spec.slice(0, equals);
    version = spec.slice(equals + 2);
  } else {
    const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
    name = at < 0 ? spec : spec.slice(0, at);
    version = at < 0 ? "" : spec.slice(at + 1);
  }
  if (python && /[<>=!~]/.test(name)) {
    throw floating(spec, "a range", name.replace(/[<>=!~].*$/, ""));
  }
  if (!PACKAGE_NAME.test(name)) {
    throw new BotError(
      `"${spec}" is not a package name and version; write the package from a registry as name@1.2.3`,
    );
  }
  if (version.length === 0) throw floating(spec, "no version", name);
  if (version === "latest" || version === "next" || /^[a-z]+$/i.test(version)) {
    throw floating(spec, `"${version}" is a tag that moves`, name);
  }
  if (!EXACT.test(version)) throw floating(spec, `"${version}" is a range or not an exact version`, name);
  return { package: name, version };
}

/**
 * The package a command runs, with its pinned version, or null when the command
 * is not a package runner (a program or script the person already has). A
 * runner with no version, a tag or a range is refused.
 */
export function packageOfCommand(command: string, args: readonly string[]): PackageRef | null {
  const runner = basename(command).toLowerCase().replace(/\.(?:cmd|exe)$/, "");
  let rest: readonly string[];
  let python = false;
  if (NPM_RUNNERS.has(runner)) rest = args;
  else if (PYTHON_RUNNERS.has(runner)) {
    rest = runner === "pipx" ? (args[0] === "run" ? args.slice(1) : []) : args;
    python = true;
    if (rest.length === 0) return null;
  } else if (["npm", "pnpm", "yarn", "bun"].includes(runner) && ["exec", "dlx", "x"].includes(args[0] ?? "")) {
    rest = args.slice(1);
  } else if (runner === "uv" && args[0] === "tool" && args[1] === "run") {
    rest = args.slice(2);
    python = true;
  } else return null;
  for (const word of rest) {
    if (FLAGS_WITH_PACKAGE.has(word) || /^--(?:package|from|with)=/.test(word)) {
      throw new BotError(`"${word}" names a package in a form that is not read here; give the package as the first argument, as name@1.2.3`);
    }
    if (word.startsWith("-")) continue;
    return packageOf(word, python);
  }
  throw new BotError(`"${command}" is given no package; give it as name@1.2.3`);
}

/** The registration as a person reads the command. */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word))).join(" ");
}

/** One tool that changed between two lists. */
export interface ToolChange {
  readonly name: string;
  readonly before: string;
  readonly after: string;
}

/** What differs between the tool lists of a server before and after. */
export interface ToolDifference {
  readonly added: readonly McpTool[];
  readonly removed: readonly McpTool[];
  readonly changed: readonly ToolChange[];
}

/** Compares two tool lists by name and description. */
export function compareTools(before: readonly McpTool[], after: readonly McpTool[]): ToolDifference {
  const was = new Map(before.map((tool) => [tool.name, tool]));
  const now = new Map(after.map((tool) => [tool.name, tool]));
  return {
    added: after.filter((tool) => !was.has(tool.name)),
    removed: before.filter((tool) => !now.has(tool.name)),
    changed: after.flatMap((tool) => {
      const old = was.get(tool.name);
      return old !== undefined && old.description !== tool.description
        ? [{ name: tool.name, before: old.description, after: tool.description }]
        : [];
    }),
  };
}

/** The difference as lines a person reads. */
export function differenceLines(diff: ToolDifference): string[] {
  const out: string[] = [];
  for (const tool of diff.added) out.push(`+ ${tool.name}: ${tool.description}`);
  for (const tool of diff.removed) out.push(`- ${tool.name}: ${tool.description}`);
  for (const change of diff.changed) {
    out.push(`~ ${change.name}`, `    before: ${change.before}`, `    after:  ${change.after}`);
  }
  return out.length === 0 ? ["The tools are the same."] : out;
}

/** The stored tools of a settings entry, read defensively. */
export function storedTools(entry: McpServerSettings): readonly McpTool[] {
  return entry.tools ?? [];
}

/** What the guard writes when a server's tools are not the ones a person approved. */
export interface ChangeReport {
  readonly bot: string;
  readonly server: string;
  readonly digest: string;
  readonly tools: readonly McpTool[];
}

/** A report read from a file, or undefined when it is not one. */
export function readReport(value: unknown): ChangeReport | undefined {
  if (!isRecord(value) || typeof value.bot !== "string" || typeof value.server !== "string" || typeof value.digest !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.tools)) return undefined;
  const tools: McpTool[] = [];
  for (const item of value.tools) {
    if (!isRecord(item) || typeof item.name !== "string") return undefined;
    tools.push({ name: item.name, description: typeof item.description === "string" ? item.description : "" });
  }
  return { bot: value.bot, server: value.server, digest: value.digest, tools };
}
