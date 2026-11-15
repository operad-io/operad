/**
 * The commands a chat offers on `/`: the actions an object marks with a
 * description, the name each is typed by, and the hint for its arguments.
 * Nothing here runs an action: a chosen command only fills the chat's input,
 * and the line goes through the chat's send action like any other text.
 */

import type { ViewAction, ViewRow } from "@operad-io/engine";
import { allowedText, argFields, type ArgField, type ArgOption } from "./args.ts";
import { sanitize } from "./sanitize.ts";

/** One command, as the input lists it. */
export interface TuiChatCommand {
  readonly action: ViewAction;
  /** The action under the same name, for a caller that knows the action side. */
  readonly info: ViewAction;
  /** The name typed after the slash, with the clash rule applied. */
  readonly name: string;
  /** The name with its slash. */
  readonly slash: string;
  /** The one-line description from the action's declaration. */
  readonly description: string;
  /** The same description, under the palette's word. */
  readonly title: string;
  /** The arguments in one line; a choice lists its options. */
  readonly hint: string;
  /** The arguments the action asks for, in order. */
  readonly fields: readonly ArgField[];
  /** The options of the first choice, if it is one. */
  readonly options: readonly ArgOption[];
  /** The same options as their labels. */
  readonly choices: readonly string[];
}

/** The actions and row a command list is built from. */
export interface CommandActions {
  readonly actions: readonly ViewAction[];
  readonly row?: ViewRow | undefined;
}

/** A state or an object page: the commands are the open object's. */
export interface CommandStateSource {
  readonly object?: CommandActions | undefined;
  readonly input?: unknown;
}

/** The actions and row a command list is built from: a state, an object or the actions alone. */
export type ChatCommandSource = readonly ViewAction[] | CommandActions | CommandStateSource;

/** One command as it was typed: the name and the rest of the line. */
export interface ParsedChatCommand {
  readonly name: string;
  /** The line as typed, without surrounding whitespace. */
  readonly text: string;
  /** What follows the name, without the whitespace that separated it. */
  readonly rest: string;
}

const COMMAND = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/;

function isActionList(source: ChatCommandSource): source is readonly ViewAction[] {
  return Array.isArray(source);
}

function sourceOf(
  source: ChatCommandSource,
  row?: ViewRow | undefined,
): { readonly actions: readonly ViewAction[]; readonly row: ViewRow | undefined } {
  if (isActionList(source)) return { actions: source, row };
  const object = (source as CommandStateSource).object;
  if (object !== undefined) return { actions: object.actions, row: object.row };
  const direct = source as CommandActions;
  if (Array.isArray(direct.actions)) return { actions: direct.actions, row: direct.row };
  return { actions: [], row: undefined };
}

/** Does this action declare that a chat may type it after a slash? */
export function isCommand(action: ViewAction): boolean {
  return typeof action.command === "string" && action.command.trim().length > 0;
}

const shortOf = (action: ViewAction): string =>
  action.action.length > 0 ? action.action : action.name.slice(action.name.indexOf(":") + 1);

/** The name each command is typed by; the `chat` plugin keeps a clashing short name. */
function resolvedNames(actions: readonly ViewAction[]): ReadonlyMap<string, string> {
  const groups = new Map<string, ViewAction[]>();
  for (const action of actions) {
    const short = shortOf(action);
    const group = groups.get(short) ?? [];
    group.push(action);
    groups.set(short, group);
  }
  const names = new Map<string, string>();
  for (const [short, group] of groups) {
    for (const action of group) {
      const name =
        group.length === 1 || action.plugin === "chat"
          ? short
          : `${action.plugin}_${short}`;
      names.set(action.name, name);
    }
  }
  return names;
}

/** The line after the arguments: each argument, a choice with every option. */
export function argumentHint(fields: readonly ArgField[]): string {
  return fields.map(allowedText).join(" · ");
}

/** Every command this chat has, in the order the actions are declared. */
export function chatCommands(source: ChatCommandSource, row?: ViewRow | undefined): readonly TuiChatCommand[] {
  const { actions, row: sourceRow } = sourceOf(source, row);
  const declared = actions.filter(isCommand);
  const names = resolvedNames(declared);
  return declared.map((action) => {
    const fields = argFields(action, sourceRow);
    const options = fields[0]?.kind === "pick" ? fields[0].options : [];
    const description = sanitize((action.command ?? "").replace(/\s+/g, " ").trim());
    const name = names.get(action.name) ?? shortOf(action);
    return {
      action,
      info: action,
      name,
      slash: `/${name}`,
      description,
      title: description,
      hint: argumentHint(fields),
      fields,
      options,
      choices: options.map((option) => option.label),
    };
  });
}

/** The same list under the name a caller may look for. */
export const commandsOf = chatCommands;
export const commandActions = chatCommands;

/** The command a chat has by this typed name, or undefined. */
export function findCommand(
  commands: readonly TuiChatCommand[],
  name: string,
): TuiChatCommand | undefined {
  const wanted = name.replace(/^\//, "");
  return commands.find((command) => command.name === wanted);
}

/** A message that is a command, or undefined when it is an ordinary message. */
export function parseCommand(text: string): ParsedChatCommand | undefined {
  const match = COMMAND.exec(text);
  const name = match?.[1];
  if (name === undefined) return undefined;
  return { name, text: text.trim(), rest: match?.[2] ?? "" };
}

function queryOf(text: string): string {
  const withoutSlash = text.trimStart().replace(/^\//, "");
  return (withoutSlash.split(/\s+/)[0] ?? "").toLowerCase();
}

/** How a command's name matches a typed word: prefix first, then a run, then a subsequence. */
function rank(query: string, name: string): number | undefined {
  if (query === "") return 0;
  const text = name.toLowerCase();
  if (text.startsWith(query)) return 0;
  if (text.includes(query)) return 1;
  let at = 0;
  for (const char of query) {
    at = text.indexOf(char, at);
    if (at < 0) return undefined;
    at += 1;
  }
  return 2;
}

/** The commands a filtered word keeps, best match first and declaration order on a tie. */
export function filterCommands(
  one: string | readonly TuiChatCommand[],
  two?: string | readonly TuiChatCommand[],
): readonly TuiChatCommand[] {
  const text = typeof one === "string" ? one : typeof two === "string" ? two : "";
  const commands = Array.isArray(one) ? one : Array.isArray(two) ? two : [];
  const query = queryOf(text);
  return commands
    .map((command, order) => ({ command, order, rank: rank(query, command.name) }))
    .filter((item): item is { command: TuiChatCommand; order: number; rank: number } => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((item) => item.command);
}

/** The same filter under the names a caller may look for. */
export const matchingCommands = filterCommands;
export const filterCommandEntries = filterCommands;

function textOf(source: CommandStateSource): string {
  const input = source.input as { readonly kind?: unknown; readonly text?: unknown } | undefined;
  return input?.kind === "note" && typeof input.text === "string" ? input.text : "";
}

/** The commands the open chat input lists now, filtered by what is typed after the slash. */
export function commandEntries(
  source: ChatCommandSource,
  text?: string,
): readonly TuiChatCommand[] {
  if (isActionList(source)) return filterCommands(text ?? "", chatCommands(source));
  const object = (source as CommandStateSource).object;
  if (object !== undefined) {
    return filterCommands(text ?? textOf(source as CommandStateSource), chatCommands(object));
  }
  const direct = source as CommandActions;
  if (Array.isArray(direct.actions)) {
    return filterCommands(text ?? "", chatCommands(direct));
  }
  return [];
}

/** The same list under the names a caller may look for. */
export const slashEntries = commandEntries;
export const commandsFor = commandEntries;
export const listCommands = commandEntries;

/** What choosing a command puts in the input: its slash name, and a space when it takes arguments. */
export function commandText(command: TuiChatCommand): string {
  return command.fields.length > 0 ? `${command.slash} ` : command.slash;
}

/** The same fill under the names a caller may look for. */
export const fillCommand = commandText;
export const commandFill = commandText;
export const commandLine = commandText;

/** The command the list's cursor is on. */
export function chosenCommand(state: CommandStateSource): TuiChatCommand | undefined {
  const input = state.input;
  if (typeof input !== "object" || input === null) return undefined;
  const menu = (input as { readonly commandMenu?: { readonly cursor: number } | undefined }).commandMenu;
  if (menu === undefined) return undefined;
  const entries = commandEntries(state);
  return entries[Math.min(Math.max(0, menu.cursor), entries.length - 1)];
}

/** Is the input showing the list of commands now? */
export function commandMenuOpen(
  state: { readonly input?: { readonly commandMenu?: unknown } | undefined },
): boolean {
  return state.input?.commandMenu !== undefined;
}

/** The options of a command's first choice, if it has one. */
export function commandOptions(
  command: TuiChatCommand | ViewAction,
  row?: ViewRow | undefined,
): readonly ArgOption[] {
  if ("options" in command) return command.options;
  const first = argFields(command, row)[0];
  return first?.kind === "pick" ? first.options : [];
}

export const optionsOf = commandOptions;

/** One command's arguments, in the order they are typed. */
export function commandFields(
  command: TuiChatCommand | ViewAction,
  row?: ViewRow | undefined,
): readonly ArgField[] {
  return "fields" in command ? command.fields : argFields(command, row);
}

export const commandArgs = commandFields;
export const argsOfCommand = commandFields;

/** One command's argument hint. */
export function commandHint(command: TuiChatCommand | ViewAction, row?: ViewRow | undefined): string {
  if ("fields" in command) return command.hint;
  return argumentHint(argFields(command, row));
}

export const argumentHintOf = commandHint;
export const argsHint = commandHint;
export const hintOf = commandHint;
export const commandUsage = commandHint;
