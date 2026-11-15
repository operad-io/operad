/** Slash commands in a chat: their names, their arguments and the line each leaves. */

import { messageOf, type ActionArgSchema, type ActionArgType, type ActionContext, type ActionInfo } from "@operad-io/engine";
import { CHAT_TYPE } from "./model.ts";

/** A message that is a command: `/<name>` and the rest of the text. */
export interface ParsedCommand {
  readonly name: string;
  /** The command as typed, without surrounding whitespace. */
  readonly text: string;
  /** What follows the name, without the whitespace that separated it. */
  readonly rest: string;
}

/** A command an action declares, with the name this chat types it by. */
export interface ChatCommand {
  readonly info: ActionInfo;
  readonly name: string;
}

/** What running a command gives: its line, and whether the action ran. */
export interface CommandOutcome {
  readonly outcome: string;
  readonly ok: boolean;
}

const COMMAND = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;

/**
 * The command a message is, or undefined when it is an ordinary message. The
 * whole message must start with `/`; a slash later, or an unknown name, leaves
 * it a message.
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const match = COMMAND.exec(text);
  const name = match?.[1];
  if (name === undefined) return undefined;
  return { name, text: text.trim(), rest: match?.[2] ?? "" };
}

/** The name each declared command is typed by, with the clash rule applied. */
function resolvedNames(actions: readonly ActionInfo[]): ReadonlyMap<string, string> {
  const groups = new Map<string, ActionInfo[]>();
  for (const info of actions) {
    const group = groups.get(info.action) ?? [];
    group.push(info);
    groups.set(info.action, group);
  }
  const names = new Map<string, string>();
  for (const [short, group] of groups) {
    for (const info of group) {
      const name =
        group.length === 1 || info.plugin === "chat"
          ? short
          : `${info.plugin}_${info.action}`;
      names.set(`${info.plugin}:${info.action}`, name);
    }
  }
  return names;
}

/** Every command this chat has, in the order the actions are declared. */
export function chatCommands(actions: readonly ActionInfo[]): readonly ChatCommand[] {
  const declared = actions.filter(
    (info) =>
      info.on === CHAT_TYPE &&
      typeof info.command === "string" &&
      info.command.trim().length > 0,
  );
  const names = resolvedNames(declared);
  return declared.map((info) => ({
    info,
    name: names.get(`${info.plugin}:${info.action}`) ?? info.action,
  }));
}

/** The command a chat has by this typed name, or undefined. */
export function findCommand(
  commands: readonly ChatCommand[],
  name: string,
): ChatCommand | undefined {
  return commands.find((command) => command.name === name);
}

function valueOf(text: string, schema: ActionArgSchema): unknown {
  const type: ActionArgType | undefined = schema.type;
  if (type === "number" || type === "integer") {
    return /^-?(?:\d+|\d*\.\d+)$/.test(text) ? Number(text) : text;
  }
  if (type === "boolean") {
    return text === "true" ? true : text === "false" ? false : text;
  }
  return text;
}

/**
 * The arguments a command's text gives. They are positional in the order the
 * action declares its properties: one property takes the rest of the line, and
 * with more than one the last takes what is left.
 */
function argsOf(command: ChatCommand, rest: string): Record<string, unknown> {
  const schema = command.info.args;
  const properties = schema?.properties ?? {};
  const names = Object.keys(properties);
  const text = rest.trim();
  if (names.length === 0) {
    if (text.length > 0) throw new Error(`\`/${command.name}\` takes no text after it`);
    return {};
  }
  const parts = text.length === 0 ? [] : text.split(/\s+/);
  const args: Record<string, unknown> = {};
  names.forEach((name, index) => {
    const property = properties[name];
    const last = index === names.length - 1;
    const value =
      last && parts.length >= names.length
        ? parts.slice(index).join(" ")
        : parts[index];
    if (value === undefined || property === undefined) return;
    args[name] = valueOf(value, property);
  });
  return args;
}

/** One line of what an action returned, whatever its shape. */
function outcomeText(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? "done" : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return "done";
  return JSON.stringify(value);
}

/**
 * Runs the command's action, or says why it did not run. An action that asks
 * for confirmation runs only when the text after the name is `yes`; anything
 * else refuses without changing anything.
 */
export async function runCommand(
  ctx: ActionContext,
  command: ChatCommand,
  rest: string,
): Promise<CommandOutcome> {
  try {
    if (ctx.act === undefined) {
      return { ok: false, outcome: "refused: commands cannot run here" };
    }
    if (command.info.confirm === true) {
      if (rest.trim() !== "yes") {
        return {
          ok: false,
          outcome: `send \`/${command.name} yes\` to go ahead`,
        };
      }
      const result = await ctx.act(command.info.name, {}, { yes: true });
      return { ok: true, outcome: outcomeText(result.value) };
    }
    const result = await ctx.act(command.info.name, argsOf(command, rest));
    return { ok: true, outcome: outcomeText(result.value) };
  } catch (error) {
    return { ok: false, outcome: `refused: ${messageOf(error)}` };
  }
}

/** What `/help` says: every command this chat has, with its own description. */
export function helpText(commands: readonly ChatCommand[]): string {
  const lines = commands.map(
    (command) =>
      `- \`/${command.name}\` — ${(command.info.command ?? "").replace(/\s+/g, " ").trim()}`,
  );
  return [`What you can type with \`/\` here:`, ...lines].join("\n");
}
