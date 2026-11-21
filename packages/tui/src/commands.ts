/**
 * The commands a chat offers on `/`: the actions an object marks with a
 * description, the name each is typed by, and the hint for its arguments.
 * Nothing here runs an action: a chosen command only fills the chat's input,
 * and the line goes through the chat's send action like any other text.
 */

import type { ViewAction, ViewRow } from "@operad-io/engine";
import { allowedText, argFields, type ArgField } from "./args.ts";
import { sanitize } from "./sanitize.ts";

/** One command, as the input lists it. */
export interface TuiChatCommand {
  /** The name typed after the slash, with the clash rule applied. */
  readonly name: string;
  /** The name with its slash. */
  readonly slash: string;
  /** The one-line description from the action's declaration. */
  readonly description: string;
  /** The arguments in one line; a choice lists its options. */
  readonly hint: string;
  /** The arguments the action asks for, in order. */
  readonly fields: readonly ArgField[];
}

/** The actions and row a command list is built from. */
export interface CommandActions {
  readonly actions: readonly ViewAction[];
  readonly row?: ViewRow | undefined;
}

/** The state a command list is built from: the open object's actions and input. */
export interface ChatCommandSource {
  readonly object?: CommandActions | undefined;
  readonly input?: unknown;
}

/** Does this action declare that a chat may type it after a slash? */
function isCommand(action: ViewAction): boolean {
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
export function chatCommands(
  actions: readonly ViewAction[],
  row?: ViewRow | undefined,
): readonly TuiChatCommand[] {
  const declared = actions.filter(isCommand);
  const names = resolvedNames(declared);
  return declared.map((action) => {
    const fields = argFields(action, row);
    const description = sanitize((action.command ?? "").replace(/\s+/g, " ").trim());
    const name = names.get(action.name) ?? shortOf(action);
    return {
      name,
      slash: `/${name}`,
      description,
      hint: argumentHint(fields),
      fields,
    };
  });
}

function queryOf(text: string): string {
  const withoutSlash = text.trimStart().replace(/^\//, "");
  return (withoutSlash.split(/\s+/)[0] ?? "").toLowerCase();
}

/** The commands a filtered word keeps, in declaration order. */
export function filterCommands(
  text: string,
  commands: readonly TuiChatCommand[],
): readonly TuiChatCommand[] {
  const query = queryOf(text);
  return query === ""
    ? commands
    : commands.filter((command) => command.name.toLowerCase().startsWith(query));
}

function textOf(source: ChatCommandSource): string {
  const input = source.input as { readonly kind?: unknown; readonly text?: unknown } | undefined;
  return input?.kind === "note" && typeof input.text === "string" ? input.text : "";
}

/** The commands the open chat input lists now, filtered by what is typed after the slash. */
export function commandEntries(
  source: ChatCommandSource,
  text?: string,
): readonly TuiChatCommand[] {
  const object = source.object;
  if (object === undefined) return [];
  return filterCommands(text ?? textOf(source), chatCommands(object.actions, object.row));
}

/** What choosing a command puts in the input: its slash name, and a space when it takes arguments. */
export function commandText(command: TuiChatCommand): string {
  return command.fields.length > 0 ? `${command.slash} ` : command.slash;
}
