/**
 * The action half of the reducer: the main action, the `:` palette, bound keys,
 * the note input and the confirmation. Everything here is a pure function of the
 * state; the shell sends the request this code leaves in `actionRequest`.
 */

import type { ViewAction, ViewRow } from "@operad-io/engine";
import { argFields, parseArg, type ArgField } from "./args.ts";
import { sanitize } from "./sanitize.ts";
import type { TuiBinding, TuiInput, TuiState } from "./state.ts";
import { graphemes } from "./wrap.ts";

/** The key that runs the main action when the plugin binds none to it. */
export const MAIN_KEY = "a";

/**
 * Every key the TUI uses itself for navigation and control (lower case). A
 * plugin default or a `keys.json` entry on one of these is dropped when the
 * bindings are resolved; `handleKey` never looks a binding up for them.
 */
export const RESERVED_KEYS: readonly string[] = [
  "enter", "return", "escape", "esc", "tab",
  "up", "down", "left", "right", "arrowup", "arrowdown", "arrowleft", "arrowright",
  "pageup", "page-up", "prior", "pagedown", "page-down", "next",
  "home", "end", "space", " ",
  "[", "]", ":", "?", "/",
  "b", "f", "g", "j", "k", "n", "p", "q", "r",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

/** Is `key` one the TUI keeps for itself? Letters match in either case. */
export function isReserved(key: string): boolean {
  const lowered = key.toLowerCase();
  // handleKey ignores every Ctrl or Meta chord, so none can be bound.
  return RESERVED_KEYS.includes(lowered) || CHORD.test(lowered);
}

const CHORD = /^(ctrl|control|meta|cmd|command|alt|option|opt|super)[-+].|^\^./;

/** The bindings that may run actions, and the footer line naming those dropped. */
export function resolveBindings(bindings: readonly TuiBinding[]): {
  readonly bindings: readonly TuiBinding[];
  readonly notice: string | undefined;
} {
  const kept = bindings.filter((binding) => !isReserved(binding.key));
  const dropped = bindings.filter((binding) => isReserved(binding.key));
  return {
    bindings: kept,
    notice:
      dropped.length === 0
        ? undefined
        : sanitize(
            `reserved keys ignored: ${dropped
              .map((b) => `${b.key} (${b.action}, ${b.source})`)
              .join(", ")}`,
          ),
  };
}

/** The palette's groups, in the order they are shown. */
export const PALETTE_GROUPS = ["actions", "tui"] as const;
export type TuiPaletteGroup = (typeof PALETTE_GROUPS)[number];

/** One line of the palette. */
export interface TuiPaletteEntry {
  readonly group: TuiPaletteGroup;
  /** `<plugin>:<action>` for an action; the command's words for the TUI. */
  readonly name: string;
  /** One line that says what the entry does; search reads it too. */
  readonly title: string;
  /** Set on a TUI command: what the reducer runs. */
  readonly command?: TuiCommand | undefined;
  readonly key: string | undefined;
  readonly needsNote: boolean;
  readonly confirm: boolean;
  /** Set when the query carries a value for the action's first argument. */
  readonly typed?: { readonly value: unknown } | undefined;
  /** Set when that value does not fit: the values the argument allows. */
  readonly refusal?: string | undefined;
}

/** The key that should reach `bindings`: a shifted letter is upper case. */
export function keyLabel(key: string, shift: boolean): string {
  return shift && /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
}

/** The binding for a key; a user binding beats a plugin default. */
export function bindingFor(
  bindings: readonly TuiBinding[],
  key: string,
  source?: "plugin" | "user",
): TuiBinding | undefined {
  const found = bindings.filter(
    (binding) => binding.key === key && (source === undefined || binding.source === source),
  );
  return found.find((binding) => binding.source === "user") ?? found[0];
}

/** The key bound to an action, a user binding first. */
export function keyOf(
  bindings: readonly TuiBinding[],
  action: ViewAction,
): string | undefined {
  const mine = bindings.filter((binding) => binding.action === action.name);
  // A key is only the action's key when it still resolves to it.
  const live = mine.filter((binding) => bindingFor(bindings, binding.key)?.action === action.name);
  return (
    live.find((binding) => binding.source === "user")?.key ??
    live[0]?.key
  );
}

function bareId(id: string): string {
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
}

/** The first available action, the one the footer offers. */
export function mainAction(state: TuiState): ViewAction | undefined {
  return state.object?.actions[0];
}

/** The key the footer shows for the main action. */
export function mainKey(state: TuiState): string | undefined {
  const main = mainAction(state);
  const own = main === undefined ? undefined : keyOf(state.bindings, main);
  if (own !== undefined) return own;
  // `a` runs the main action only while no binding claims it.
  return bindingFor(state.bindings, MAIN_KEY) === undefined ? MAIN_KEY : undefined;
}

/** Does `query` match `name` as a subsequence? Lower is better; -1 is none. */
export function fuzzyScore(query: string, name: string): number {
  const wanted = query.toLowerCase().replace(/\s+/g, "");
  if (wanted === "") return 0;
  const text = name.toLowerCase();
  let at = 0;
  let first = -1;
  let last = -1;
  for (const char of graphemes(wanted)) {
    const found = text.indexOf(char, at);
    if (found < 0) return -1;
    if (first < 0) first = found;
    last = found;
    at = found + char.length;
  }
  // A tight match near the start of the name ranks first.
  return (last - first) * 100 + first;
}

/** What a TUI command does; each is what a key does. */
export type TuiCommand =
  | { readonly kind: "help" | "refresh" | "back" | "quit" }
  | { readonly kind: "go"; readonly tabId: string };

function commandEntries(state: TuiState): readonly TuiPaletteEntry[] {
  const make = (
    name: string,
    title: string,
    key: string | undefined,
    command: TuiCommand,
  ): TuiPaletteEntry => ({
    group: "tui",
    name,
    title,
    key,
    needsNote: false,
    confirm: false,
    command,
  });
  const tabs = state.tabs.map((tab, at) => ({ tab, key: at < 9 ? String(at + 1) : undefined }));
  const go = (kind: "pending" | "running"): TuiPaletteEntry | undefined => {
    const found = tabs.find((item) => item.tab.kind === kind);
    return found === undefined
      ? undefined
      : make(`go to ${kind}`, `show the ${kind} list`, found.key, { kind: "go", tabId: found.tab.id });
  };
  const types = tabs
    .filter((item) => item.tab.kind === "type")
    .map((item) =>
      make(`go to ${item.tab.title}`, `show the list of ${item.tab.title}`, item.key, {
        kind: "go",
        tabId: item.tab.id,
      }),
    );
  return [
    make("help", "show or hide the key list", "?", { kind: "help" }),
    make("refresh", "load the lists again", "r", { kind: "refresh" }),
    ...[go("pending"), go("running")].filter((entry): entry is TuiPaletteEntry => entry !== undefined),
    ...types,
    make("go back", "close the open object", "escape", { kind: "back" }),
    make("quit", "leave the TUI", "q", { kind: "quit" }),
  ];
}

/** The palette's lines for the typed query: groups in order, best match first inside one. */
export function paletteEntries(state: TuiState): readonly TuiPaletteEntry[] {
  const object = state.object;
  const query = state.input?.kind === "palette" ? state.input.query : "";
  const words = query.trim().split(/\s+/);
  const actions: readonly TuiPaletteEntry[] =
    object === undefined
      ? []
      : object.actions.map((action) => ({
          group: "actions",
          name: action.name,
          title: `${action.name} on ${bareId(object.id)}`,
          key: keyOf(state.bindings, action),
          needsNote: action.note !== undefined,
          confirm: action.confirm,
          ...typedValue(action, object.row, words),
        }));
  const rank = (entries: readonly TuiPaletteEntry[]): readonly TuiPaletteEntry[] =>
    entries
      .map((entry, order) => {
        // Words after the action's name are its first argument, not part of the search.
        const hasValue = entry.typed !== undefined || entry.refusal !== undefined;
        const search = hasValue ? (words[0] ?? "") : query;
        const byName = fuzzyScore(search, entry.name);
        const byTitle = hasValue ? -1 : fuzzyScore(search, entry.title);
        // A name match outranks a match that only the title has.
        const score = byName >= 0 ? byName : byTitle >= 0 ? byTitle + 100000 : -1;
        return { entry, order, score };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => a.score - b.score || a.order - b.order)
      .map((item) => item.entry);
  return [...rank(actions), ...rank(commandEntries(state))];
}

/** The value typed after an action's name, checked against its first argument. */
function typedValue(
  action: ViewAction,
  row: ViewRow,
  words: readonly string[],
): Pick<TuiPaletteEntry, "typed" | "refusal"> {
  if (words.length < 2) return {};
  const field = argFields(action, row)[0];
  if (field === undefined) return {};
  // Only an action that the first word names takes the rest as its value.
  if (fuzzyScore(words[0] ?? "", action.name) < 0) return {};
  const parsed = parseArg(field, words.slice(1).join(" "));
  return parsed.ok ? { typed: { value: parsed.value } } : { refusal: parsed.reason };
}

/** The entry the palette cursor is on. */
export function chosenEntry(state: TuiState): TuiPaletteEntry | undefined {
  const input = state.input;
  if (input?.kind !== "palette") return undefined;
  const entries = paletteEntries(state);
  return entries[Math.min(input.cursor, entries.length - 1)];
}

/** The words after an entry: its key and what it asks. */
export function entryHint(entry: TuiPaletteEntry): string {
  if (entry.refusal !== undefined) return entry.refusal;
  return [
    entry.key,
    entry.needsNote ? "needs a note" : undefined,
    entry.confirm ? "asks to confirm" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function withNotice(state: TuiState, notice: string): TuiState {
  return { ...state, notice: sanitize(notice) };
}

/** Runs an action on the open object, or says why it cannot. */
export function startAction(
  state: TuiState,
  name: string,
  first?: { readonly value: unknown },
): TuiState {
  const object = state.object;
  const closed: TuiState = { ...state, input: undefined };
  if (object === undefined) return withNotice(closed, "no object is selected");
  if (state.acting) return withNotice(closed, "the last action has not answered yet");
  const action = object.actions.find((candidate) => candidate.name === name);
  if (action === undefined) {
    return withNotice(closed, `${name} is not available for ${bareId(object.id)}`);
  }
  const fields = argFields(action, object.row);
  const note = action.note === undefined ? undefined : { required: action.noteRequired };
  if (fields.length > 0) {
    const asking = argsInput(action.name, object.id, fields, 0, {}, note, action.confirm);
    return first === undefined ? { ...closed, input: asking } : answer(closed, asking, first.value);
  }
  return afterArgs(closed, action.name, object.id, {}, note, action.confirm);
}

type ArgsInput = Extract<TuiInput, { readonly kind: "args" }>;

function argsInput(
  action: string,
  id: string,
  fields: readonly ArgField[],
  at: number,
  values: Readonly<Record<string, unknown>>,
  note: ArgsInput["note"],
  confirm: boolean,
): ArgsInput {
  const field = fields[at];
  return {
    kind: "args",
    action,
    id,
    fields,
    at,
    values,
    cursor: field?.current ?? 0,
    text: field?.initial ?? "",
    note,
    confirm,
  };
}

/** Records the answer to the field being asked and moves to the next step. */
function answer(state: TuiState, input: ArgsInput, value: unknown): TuiState {
  const field = input.fields[input.at];
  if (field === undefined) return { ...state, input: undefined };
  const values = { ...input.values, [field.name]: value };
  if (input.at + 1 < input.fields.length) {
    return {
      ...state,
      input: argsInput(input.action, input.id, input.fields, input.at + 1, values, input.note, input.confirm),
    };
  }
  return afterArgs({ ...state, input: undefined }, input.action, input.id, values, input.note, input.confirm);
}

/** Every argument is in: the note, the confirmation or the request comes next. */
function afterArgs(
  state: TuiState,
  action: string,
  id: string,
  args: Readonly<Record<string, unknown>>,
  note: ArgsInput["note"],
  confirm: boolean,
): TuiState {
  const given = Object.keys(args).length === 0 ? {} : { args };
  if (note !== undefined) {
    return {
      ...state,
      input: { kind: "note", action, id, text: "", required: note.required, confirm, ...given },
    };
  }
  if (confirm) return { ...state, input: { kind: "confirm", action, id, ...given } };
  return send(state, { action, id, ...given });
}

function send(
  state: TuiState,
  request: {
    action: string;
    id: string;
    note?: string;
    args?: Readonly<Record<string, unknown>>;
    confirmed?: boolean;
  },
): TuiState {
  return { ...state, input: undefined, acting: true, actionRequest: request };
}

/** `a`, or a bound key: the key that reached the reducer, as a label. */
export function runKey(state: TuiState, label: string): TuiState | undefined {
  const bound = bindingFor(state.bindings, label);
  if (bound !== undefined) return startAction(state, bound.action);
  if (label === MAIN_KEY) {
    const main = mainAction(state);
    return main === undefined
      ? withNotice(state, "no action is available")
      : startAction(state, main.name);
  }
  return undefined;
}

/** The text a key adds to an input, if it adds any. */
export function typed(event: { readonly text?: string | undefined }): string | undefined {
  const text = event.text;
  return text === undefined || text === "" || /[\u0000-\u001f\u007f]/.test(text)
    ? undefined
    : text;
}

export function dropLast(text: string): string {
  const all = graphemes(text);
  all.pop();
  return all.join("");
}

/** A key arrives while the palette, a note or a confirmation is open. */
export function inputKey(
  state: TuiState,
  input: Exclude<TuiInput, { readonly kind: "pages" }>,
  event: {
    readonly key: string;
    readonly text?: string | undefined;
    readonly shift?: boolean | undefined;
    readonly ctrl?: boolean | undefined;
    readonly meta?: boolean | undefined;
  },
): TuiState {
  const key = event.key.toLowerCase();
  const escape = key === "escape" || key === "esc";
  const enter = key === "enter" || key === "return";
  if (input.kind === "confirm") {
    const yes = event.ctrl !== true && event.meta !== true && (key === "y" || event.text === "y" || event.text === "Y");
    if (!yes) return { ...state, input: undefined };
    return send(state, {
      action: input.action,
      id: input.id,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.args === undefined ? {} : { args: input.args }),
      confirmed: true,
    });
  }
  if (escape) return { ...state, input: undefined };
  if (input.kind === "args") return argsKey(state, input, event, key, enter);
  if (input.kind === "palette") {
    const entries = paletteEntries(state);
    const down = key === "down" || key === "arrowdown" || (event.ctrl === true && (key === "n" || key === "j"));
    const up = key === "up" || key === "arrowup" || (event.ctrl === true && (key === "p" || key === "k"));
    if (down || up) {
      const cursor = Math.min(
        Math.max(0, input.cursor + (down ? 1 : -1)),
        Math.max(0, entries.length - 1),
      );
      return { ...state, input: { ...input, cursor } };
    }
    if (enter) {
      const chosen = chosenEntry(state);
      // A command is run by the reducer that owns the state it changes.
      // A value that does not fit stays in the palette, with what is allowed.
      return chosen === undefined || chosen.command !== undefined || chosen.refusal !== undefined
        ? state
        : startAction({ ...state, input: undefined }, chosen.name, chosen.typed);
    }
    if (key === "backspace") {
      return { ...state, input: { ...input, query: dropLast(input.query), cursor: 0 } };
    }
    const text = event.ctrl === true || event.meta === true ? undefined : typed(event);
    return text === undefined
      ? state
      : { ...state, input: { ...input, query: input.query + text, cursor: 0 } };
  }
  // A note: Enter sends, Shift-Enter or Ctrl-J adds a line.
  const newline = (enter && event.shift === true) || (event.ctrl === true && (key === "j" || key === "linefeed")) || key === "linefeed";
  if (newline) return { ...state, input: { ...input, text: `${input.text}\n` } };
  if (enter) {
    const note = input.text;
    if (note.trim() === "" && input.required) return withNotice(state, "a note is required");
    if (input.confirm) {
      return {
        ...state,
        input: {
          kind: "confirm",
          action: input.action,
          id: input.id,
          ...(note === "" ? {} : { note }),
          ...(input.args === undefined ? {} : { args: input.args }),
        },
      };
    }
    return send(state, {
      action: input.action,
      id: input.id,
      ...(note === "" ? {} : { note }),
      ...(input.args === undefined ? {} : { args: input.args }),
    });
  }
  if (key === "backspace") return { ...state, input: { ...input, text: dropLast(input.text) } };
  const text = event.ctrl === true || event.meta === true ? undefined : typed(event);
  return text === undefined ? state : { ...state, input: { ...input, text: input.text + text } };
}

/** The server refused (or the network failed): show its line, without the HTTP status. */
export function actionFailed(
  state: TuiState,
  _status: number | undefined,
  message: string,
): TuiState {
  return { ...withNotice(state, message), acting: false, actionRequest: undefined };
}

/** A key arrives while an argument is asked. */
function argsKey(
  state: TuiState,
  input: ArgsInput,
  event: { readonly text?: string | undefined; readonly ctrl?: boolean | undefined; readonly meta?: boolean | undefined },
  key: string,
  enter: boolean,
): TuiState {
  const field = input.fields[input.at];
  if (field === undefined) return { ...state, input: undefined };
  if (field.kind === "pick") {
    const down = key === "down" || key === "arrowdown" || (event.ctrl !== true && event.text === "j") || (event.ctrl === true && (key === "n" || key === "j"));
    const up = key === "up" || key === "arrowup" || (event.ctrl !== true && event.text === "k") || (event.ctrl === true && (key === "p" || key === "k"));
    if (down || up) {
      const cursor = Math.min(Math.max(0, input.cursor + (down ? 1 : -1)), field.options.length - 1);
      return { ...state, input: { ...input, cursor } };
    }
    const option = field.options[input.cursor];
    return enter && option !== undefined ? answer(state, input, option.value) : state;
  }
  if (enter) {
    const parsed = parseArg(field, input.text);
    return parsed.ok
      ? answer(state, input, parsed.value)
      : { ...state, input: { ...input, error: parsed.reason } };
  }
  if (key === "backspace") {
    return { ...state, input: { ...input, text: dropLast(input.text), error: undefined } };
  }
  const text = event.ctrl === true || event.meta === true ? undefined : typed(event);
  return text === undefined
    ? state
    : { ...state, input: { ...input, text: input.text + text, error: undefined } };
}

/** The footer line a confirmation asks, in red. */
export function confirmText(state: TuiState): string | undefined {
  const input = state.input;
  return input?.kind === "confirm"
    ? `${input.action} ${bareId(input.id)}? [y/N]`
    : undefined;
}
