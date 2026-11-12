/**
 * Registering a local MCP server of a bot is a proposal a person approves; so
 * is an upgrade, and so is letting a server through after its tools changed.
 * Nothing is written to the bot's settings until then.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { match } from "@operad-io/access-match";
import {
  FileSecretStore,
  messageOf,
  type CommandContext,
  type JsonValue,
  type ObjectStore,
} from "@operad-io/engine";
import { BotError, accessFor, readBots, resolveBot, type McpServerSettings } from "./bot.ts";
import { baseEnvironment, probeServer } from "./mcp-client.ts";
import {
  commandLine,
  packageOfCommand,
  parsePasted,
  readReport,
  reportDirectory,
  secretName,
  toolDigest,
  validateServerName,
  type McpRegistration,
} from "./mcp.ts";
import { PROPOSAL_TYPE, mcpChangeOf, type McpChange, type ProposalData } from "./proposals.ts";

async function allProposals(store: ObjectStore): Promise<Array<{ readonly id: string; readonly data: Readonly<Record<string, unknown>> }>> {
  const found: Array<{ readonly id: string; readonly data: Readonly<Record<string, unknown>> }> = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(PROPOSAL_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) found.push({ id: object.id, data: object.data });
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

async function put(store: ObjectStore, data: ProposalData, cause: string): Promise<string> {
  const id = `p-${randomUUID()}`;
  await store.put(PROPOSAL_TYPE, id, data as unknown as Record<string, JsonValue>, cause);
  return id;
}

/** How long reading the tool list of a server may take, in milliseconds. */
export const PROBE_TIMEOUT_MS = 60_000;

export interface ProposeMcpOptions {
  /** How long the server may take to answer; the default is `PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Proposes a local MCP server for a bot: a new one, or an upgrade of one it
 * lists. The command is checked first (a floating version is refused and the
 * server is not started); then the server is started once, in the bot's
 * working directory with a bare environment and its own secrets, to read its
 * tool list.
 */
export async function proposeMcp(
  store: ObjectStore,
  home: string,
  bot: string,
  name: string,
  registration: McpRegistration,
  options: ProposeMcpOptions = {},
): Promise<string> {
  validateServerName(name);
  const written = readBots(home)[bot];
  if (written === undefined) throw new BotError(`there is no bot "${bot}"`);
  const pinned = packageOfCommand(registration.command, registration.args);
  const resolved = resolveBot(home, bot, written);
  // The bot's access profile applies to starting the server, as it does to any command of the bot.
  const verdict = match(accessFor(home, written), {
    tool: "bash",
    input: { command: commandLine(registration.command, registration.args) },
    cwd: resolved.cwd,
  });
  if (!verdict.allow && verdict.ask !== true) {
    throw new BotError(`the access profile of bot ${bot} refuses this command: ${verdict.reason}`);
  }

  const before = written.mcpServers?.[name] ?? null;
  const variables = [...new Set([...(before?.secrets ?? []), ...registration.variables])];
  const env = baseEnvironment();
  const secrets = new FileSecretStore({ home, plugin: "bot" });
  for (const variable of variables) {
    const stored = await secrets.get(secretName(name, variable));
    if (stored !== undefined) env[variable] = stored.reveal();
  }
  // Values pasted with the registration only serve this one start; they are not kept.
  Object.assign(env, registration.given);

  mkdirSync(resolved.cwd, { recursive: true });
  let tools;
  try {
    tools = await probeServer({
      command: registration.command,
      args: registration.args,
      cwd: resolved.cwd,
      env,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new BotError(
      `could not read the tools of "${name}" by starting it: ${messageOf(error)}${
        variables.length === 0 ? "" : `. It may need its secrets first: ${variables.map((v) => secretName(name, v)).join(", ")} (operad secret set bot <name>)`
      }`,
    );
  }
  const after: McpServerSettings = {
    command: registration.command,
    ...(registration.args.length === 0 ? {} : { args: [...registration.args] }),
    ...(pinned === null ? {} : { package: pinned.package, version: pinned.version }),
    ...(variables.length === 0 ? {} : { secrets: variables }),
    tools: [...tools],
    digest: toolDigest(tools),
  };
  const change: McpChange = { server: name, reason: before === null ? "new" : "upgrade", before, after };
  const data: ProposalData = {
    bot,
    kind: "mcp",
    title: before === null ? `MCP server ${name}` : `MCP server ${name} upgrade`,
    state: "pending",
    createdAt: Date.now(),
    mcp: change,
  };
  await put(store, data, "command:bot/mcp");
  const dropped = Object.keys(registration.given).length;
  return `proposed MCP server "${name}" for bot ${bot} (${tools.length} tools); review it in pending${
    dropped === 0 ? "" : `. The ${dropped} value(s) given in env were used once to start it and are not kept; store them as secrets`
  }`;
}

/**
 * Turns what guards left (a server whose tools differ from the approved ones)
 * into pending items, and removes the reports. A report for a list that already
 * has a proposal, pending or answered, makes no second one: a rejected change
 * keeps the server off without asking again.
 */
export async function ingestReports(store: ObjectStore, home: string): Promise<void> {
  const directory = reportDirectory(home);
  if (!existsSync(directory)) return;
  const known = (await allProposals(store)).flatMap(({ data }) => {
    const change = mcpChangeOf(data.mcp);
    return typeof data.bot === "string" && change !== undefined ? [`${data.bot}\0${change.server}\0${change.after.digest ?? ""}`] : [];
  });
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    const path = join(directory, file);
    let report;
    try {
      report = readReport(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      report = undefined;
    }
    rmSync(path, { force: true });
    if (report === undefined) continue;
    const entry = readBots(home)[report.bot]?.mcpServers?.[report.server];
    // Our own digest, not the report's: the file is only a list of tools.
    const digest = toolDigest(report.tools);
    if (entry === undefined || entry.digest === digest) continue;
    const key = `${report.bot}\0${report.server}\0${digest}`;
    if (known.includes(key)) continue;
    known.push(key);
    const after: McpServerSettings = { ...entry, tools: [...report.tools], digest };
    await put(
      store,
      {
        bot: report.bot,
        kind: "mcp",
        title: `MCP server ${report.server} changed its tools`,
        state: "pending",
        createdAt: Date.now(),
        mcp: { server: report.server, reason: "changed", before: entry, after },
      },
      "guard:bot/mcp",
    );
  }
}

/**
 * Parses `<bot> <name> [<command> [args...]]` for the `bot mcp` command. With no
 * command, stdin is a pasted `mcpServers` entry.
 */
export async function runMcpCommand(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const bot = argv[0];
  const name = argv[1];
  if (bot === undefined || name === undefined) {
    throw new BotError("usage: operad bot mcp <bot> <name> <command> [args...]   or   operad bot mcp <bot> <name> < pasted-entry.json");
  }
  const words = argv.slice(2);
  let registration: McpRegistration;
  if (words.length > 0) {
    const command = words[0] ?? "";
    registration = { command, args: words.slice(1), variables: [], given: {} };
  } else {
    const text = (ctx.input ?? "").trim();
    if (text.length === 0) throw new BotError("give the server as a command with arguments, or paste its mcpServers entry on stdin");
    registration = parsePasted(text, name);
  }
  return proposeMcp(ctx.store, ctx.home, bot, name, registration);
}
